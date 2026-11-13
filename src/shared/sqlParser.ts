// A tolerant, dialect-agnostic DDL parser that replays a sequence of SQL scripts
// (e.g. numbered migration files) and produces the resulting schema.
//
// It understands CREATE TABLE, ALTER TABLE (add/drop/rename/alter column, add/drop constraint,
// rename table, set schema), DROP TABLE, CREATE UNIQUE INDEX, COMMENT ON, SET search_path,
// and DDL nested inside PostgreSQL DO $$ ... $$ blocks and T-SQL IF/BEGIN blocks.
// Anything else (functions, triggers, views, DML, grants) is skipped.

import { Column, Dialect, FkAction, Relation, Schema, Table, UserType } from './model';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokKind = 'word' | 'qident' | 'string' | 'dollar' | 'number' | 'punct' | 'op';

export interface Tok {
  k: TokKind;
  /** Value: identifier text (unquoted), string contents, or the punctuation itself. */
  v: string;
  /** Upper-cased value for words, used for keyword matching. */
  u: string;
  /** Raw source text. */
  raw: string;
  /** True if this is the first token on its line. */
  ls: boolean;
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_CHAR = /[A-Za-z0-9_$#@\u0080-￿]/;

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  let lineStart = true;
  const push = (k: TokKind, v: string, raw: string) => {
    out.push({ k, v, u: k === 'word' ? v.toUpperCase() : v, raw, ls: lineStart });
    lineStart = false;
  };
  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      lineStart = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '﻿') {
      i++;
      continue;
    }
    // -- line comment
    if (c === '-' && src[i + 1] === '-') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // /* block comment */ (nestable, as in PostgreSQL)
    if (c === '/' && src[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (src[i] === '*' && src[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          if (src[i] === '\n') lineStart = true;
          i++;
        }
      }
      continue;
    }
    // 'string' (with optional E/N/B/X prefix handled in the word branch)
    if (c === "'") {
      const start = i;
      const v = readQuoted(src, i, "'", false);
      i = v.end;
      push('string', v.value, src.slice(start, i));
      continue;
    }
    // "quoted identifier"
    if (c === '"') {
      const start = i;
      const v = readQuoted(src, i, '"', false);
      i = v.end;
      push('qident', v.value, src.slice(start, i));
      continue;
    }
    // `mysql identifier`
    if (c === '`') {
      const start = i;
      const v = readQuoted(src, i, '`', false);
      i = v.end;
      push('qident', v.value, src.slice(start, i));
      continue;
    }
    // [T-SQL identifier] — only when the contents look like an identifier, so `text[]` and
    // `ARRAY['a']` are not mistaken for one.
    if (c === '[') {
      const close = src.indexOf(']', i + 1);
      if (close > i + 1) {
        const inner = src.slice(i + 1, close);
        if (/^[A-Za-z_\u0080-￿][^\[\]\n']*$/.test(inner)) {
          push('qident', inner, src.slice(i, close + 1));
          i = close + 1;
          continue;
        }
      }
      push('punct', '[', '[');
      i++;
      continue;
    }
    // $tag$ dollar quoting $tag$
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const bodyStart = i + tag.length;
        const end = src.indexOf(tag, bodyStart);
        const stop = end === -1 ? n : end;
        const body = src.slice(bodyStart, stop);
        const rawEnd = end === -1 ? n : end + tag.length;
        out.push({ k: 'dollar', v: body, u: body, raw: src.slice(i, rawEnd), ls: lineStart });
        i = rawEnd;
        lineStart = false;
        continue;
      }
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?|^[0-9]+\.?/.exec(src.slice(i, i + 64));
      const t = m ? m[0] : c;
      push('number', t, t);
      i += t.length;
      continue;
    }
    if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(src[j])) j++;
      const word = src.slice(i, j);
      // E'..', N'..', B'..', X'..' string prefixes
      if (src[j] === "'" && /^(?:[EeNnBbXx]|U&)$/.test(word)) {
        const v = readQuoted(src, j, "'", word.toUpperCase() === 'E');
        push('string', v.value, src.slice(i, v.end));
        i = v.end;
        continue;
      }
      push('word', word, word);
      i = j;
      continue;
    }
    if (c === ':' && src[i + 1] === ':') {
      push('op', '::', '::');
      i += 2;
      continue;
    }
    if ('(),;.'.includes(c) || c === ']') {
      push('punct', c, c);
      i++;
      continue;
    }
    // operator run
    let j = i + 1;
    while (j < n && '+-*/<>=~!@#%^&|?:'.includes(src[j]) && !(src[j] === '-' && src[j + 1] === '-')) j++;
    const op = src.slice(i, j);
    push('op', op, op);
    i = j;
  }
  return out;
}

function readQuoted(src: string, start: number, q: string, backslash: boolean): { value: string; end: number } {
  let i = start + 1;
  let value = '';
  while (i < src.length) {
    const ch = src[i];
    if (backslash && ch === '\\' && i + 1 < src.length) {
      value += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === q) {
      if (src[i + 1] === q) {
        value += q;
        i += 2;
        continue;
      }
      return { value, end: i + 1 };
    }
    value += ch;
    i++;
  }
  return { value, end: i };
}

/** Re-assemble tokens into readable SQL text. */
export function joinTokens(toks: Tok[], lowerWords = false): string {
  let s = '';
  let prev: Tok | undefined;
  for (const t of toks) {
    const text = t.k === 'word' && lowerWords ? t.raw.toLowerCase() : t.raw;
    if (prev) {
      const noSpace =
        t.v === ')' ||
        t.v === ',' ||
        t.v === '.' ||
        t.v === ']' ||
        t.v === '::' ||
        prev.v === '(' ||
        prev.v === '.' ||
        prev.v === '[' ||
        prev.v === '::' ||
        ((t.v === '(' || t.v === '[') && t.k === 'punct' && (prev.k === 'word' || prev.k === 'qident' || prev.v === ']'));
      // In type mode keep "numeric(18,2)" compact.
      if (!noSpace && !(lowerWords && prev.v === ',')) s += ' ';
    }
    s += text;
    prev = t;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Statement splitting helpers
// ---------------------------------------------------------------------------

function splitStatements(toks: Tok[]): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  for (const t of toks) {
    const isGo = t.k === 'word' && t.u === 'GO' && t.ls;
    if ((t.k === 'punct' && t.v === ';') || isGo) {
      if (cur.length) out.push(cur);
      cur = [];
      continue;
    }
    cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Split a token list on commas at parenthesis depth 0. */
function splitTopLevel(toks: Tok[], sep = ','): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  for (const t of toks) {
    if (t.k === 'punct' && (t.v === '(' || t.v === '[')) depth++;
    else if (t.k === 'punct' && (t.v === ')' || t.v === ']')) depth--;
    if (depth === 0 && t.k === 'punct' && t.v === sep) {
      out.push(cur);
      cur = [];
      continue;
    }
    cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Given index of '(' return index of its matching ')'. */
function matchParen(toks: Tok[], open: number): number {
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== 'punct') continue;
    if (t.v === '(') depth++;
    else if (t.v === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return toks.length - 1;
}

class Cur {
  i = 0;
  constructor(public t: Tok[]) {}
  get eof() {
    return this.i >= this.t.length;
  }
  peek(o = 0): Tok | undefined {
    return this.t[this.i + o];
  }
  next(): Tok | undefined {
    return this.t[this.i++];
  }
  is(word: string, o = 0): boolean {
    const t = this.t[this.i + o];
    return !!t && t.k === 'word' && t.u === word;
  }
  isAny(words: Set<string> | string[], o = 0): boolean {
    const t = this.t[this.i + o];
    if (!t || t.k !== 'word') return false;
    return Array.isArray(words) ? words.includes(t.u) : words.has(t.u);
  }
  isPunct(p: string, o = 0): boolean {
    const t = this.t[this.i + o];
    return !!t && t.k === 'punct' && t.v === p;
  }
  /** Consume a sequence of keywords if all match. */
  accept(...words: string[]): boolean {
    for (let k = 0; k < words.length; k++) if (!this.is(words[k], k)) return false;
    this.i += words.length;
    return true;
  }
  acceptPunct(p: string): boolean {
    if (this.isPunct(p)) {
      this.i++;
      return true;
    }
    return false;
  }
  isIdent(o = 0): boolean {
    const t = this.t[this.i + o];
    return !!t && (t.k === 'word' || t.k === 'qident');
  }
  ident(): string | undefined {
    const t = this.peek();
    if (!t) return undefined;
    if (t.k === 'word' || t.k === 'qident') {
      this.i++;
      return t.v;
    }
    if (t.k === 'string') {
      // MySQL allows 'quoted' names in a few places
      this.i++;
      return t.v;
    }
    return undefined;
  }
  /** Parse a dotted name: a, a.b, a.b.c (returns the parts). */
  qname(): string[] | undefined {
    const first = this.ident();
    if (first === undefined) return undefined;
    const parts = [first];
    while (this.isPunct('.')) {
      this.i++;
      const p = this.ident();
      if (p === undefined) break;
      parts.push(p);
    }
    return parts;
  }
  /** Skip a parenthesised group if present; returns the inner tokens. */
  parens(): Tok[] | undefined {
    if (!this.isPunct('(')) return undefined;
    const close = matchParen(this.t, this.i);
    const inner = this.t.slice(this.i + 1, close);
    this.i = close + 1;
    return inner;
  }
  rest(): Tok[] {
    const r = this.t.slice(this.i);
    this.i = this.t.length;
    return r;
  }
}

// ---------------------------------------------------------------------------
// Builder: mutable schema state while replaying statements
// ---------------------------------------------------------------------------

interface TableRef {
  schema?: string;
  name: string;
}

interface FkDraft {
  name: string;
  from: Table;
  fromCols: Column[];
  to: Table | TableRef;
  toCols: (Column | string)[];
  onDelete?: FkAction;
  onUpdate?: FkAction;
}

export interface ParseOptions {
  dialect?: Dialect;
}

export interface SourceFile {
  name: string;
  content: string;
}

export interface ParseResult {
  schema: Schema;
  warnings: string[];
  dialect: Dialect;
}

const COLUMN_TERMINATORS = new Set([
  'CONSTRAINT',
  'NOT',
  'NULL',
  'DEFAULT',
  'PRIMARY',
  'UNIQUE',
  'REFERENCES',
  'CHECK',
  'GENERATED',
  'COLLATE',
  'IDENTITY',
  'AUTO_INCREMENT',
  'AUTOINCREMENT',
  'COMMENT',
  'ON',
  'AS',
  'SPARSE',
  'ROWGUIDCOL',
  'FILESTREAM',
  'STORED',
  'VIRTUAL',
  'MASKED',
  'ENCRYPTED',
  'COMPRESSION',
  'STORAGE',
  'INVISIBLE',
  'VISIBLE',
]);

const TABLE_CONSTRAINT_START = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'EXCLUDE', 'PERIOD']);
const MYSQL_INDEX_START = new Set(['KEY', 'INDEX', 'FULLTEXT', 'SPATIAL']);

export function detectDialect(text: string): Dialect {
  const sample = text.slice(0, 2_000_000);
  let mssql = 0,
    mysql = 0,
    sqlite = 0,
    pg = 0;
  if (/^\s*GO\s*$/im.test(sample)) mssql += 3;
  if (/\bNVARCHAR\b|\bUNIQUEIDENTIFIER\b|\bDATETIME2\b/i.test(sample)) mssql += 2;
  if (/\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/i.test(sample)) mssql += 2;
  if (/\[dbo\]/i.test(sample)) mssql += 3;
  if (/\bAUTO_INCREMENT\b/i.test(sample)) mysql += 3;
  if (/\bENGINE\s*=/i.test(sample)) mysql += 3;
  if (/`[A-Za-z_]/.test(sample)) mysql += 2;
  if (/\bAUTOINCREMENT\b/i.test(sample)) sqlite += 3;
  if (/\bWITHOUT\s+ROWID\b/i.test(sample)) sqlite += 3;
  if (/\$\$|\bTIMESTAMPTZ\b|\bJSONB\b|\bSERIAL\b|::|\bplpgsql\b|search_path/i.test(sample)) pg += 3;
  if (/\bUUID\b|\bBIGSERIAL\b|\bBYTEA\b|\bTEXT\[\]/i.test(sample)) pg += 1;
  const best = Math.max(mssql, mysql, sqlite, pg);
  if (best <= 0) return 'postgres';
  if (best === pg) return 'postgres';
  if (best === mssql) return 'mssql';
  if (best === mysql) return 'mysql';
  return 'sqlite';
}

function defaultSchemaFor(d: Dialect): string {
  switch (d) {
    case 'postgres':
    case 'generic':
      return 'public';
    case 'mssql':
      return 'dbo';
    default:
      return '';
  }
}

function parseAction(c: Cur): FkAction | undefined {
  if (c.accept('NO', 'ACTION')) return 'NO ACTION';
  if (c.accept('RESTRICT')) return 'RESTRICT';
  if (c.accept('CASCADE')) return 'CASCADE';
  if (c.accept('SET', 'NULL')) {
    c.parens();
    return 'SET NULL';
  }
  if (c.accept('SET', 'DEFAULT')) {
    c.parens();
    return 'SET DEFAULT';
  }
  c.next();
  return undefined;
}

/** Names from an index/constraint column list: (a, b DESC, "c", lower(d)) -> [a, b, c] */
function columnList(inner: Tok[] | undefined): string[] {
  if (!inner) return [];
  const out: string[] = [];
  for (const part of splitTopLevel(inner)) {
    const t = part[0];
    if (!t) continue;
    if ((t.k === 'word' || t.k === 'qident') && !(part[1] && part[1].v === '(')) out.push(t.v);
  }
  return out;
}

class Builder {
  tables: Table[] = [];
  types: UserType[] = [];
  fks: FkDraft[] = [];
  warnings: string[] = [];
  searchPath: string[];
  file = '';
  /** True while replaying DDL inside IF/DO blocks, where "duplicates" are expected. */
  conditional = false;
  private usedIds = new Set<string>();

  constructor(public dialect: Dialect) {
    this.searchPath = [defaultSchemaFor(dialect)];
  }

  resetFile(name: string) {
    this.file = name;
    this.searchPath = [defaultSchemaFor(this.dialect)];
  }

  warn(msg: string) {
    if (this.warnings.length < 500) this.warnings.push(this.file ? `${this.file}: ${msg}` : msg);
  }

  // ---- name resolution -------------------------------------------------

  refFromParts(parts: string[]): TableRef {
    if (parts.length >= 2) return { schema: parts[parts.length - 2], name: parts[parts.length - 1] };
    return { name: parts[0] };
  }

  find(ref: TableRef): Table | undefined {
    const nm = ref.name.toLowerCase();
    if (ref.schema !== undefined) {
      const sc = ref.schema.toLowerCase();
      const hit = this.tables.find((t) => t.name.toLowerCase() === nm && t.schema.toLowerCase() === sc);
      if (hit) return hit;
      // Schemas are meaningless in SQLite/MySQL-without-schema contexts; fall back to name only
      if (this.dialect === 'sqlite' || this.dialect === 'mysql') {
        return this.tables.find((t) => t.name.toLowerCase() === nm);
      }
      return undefined;
    }
    for (const s of this.searchPath) {
      const sc = s.toLowerCase();
      const hit = this.tables.find((t) => t.name.toLowerCase() === nm && t.schema.toLowerCase() === sc);
      if (hit) return hit;
    }
    // PostgreSQL resolves unqualified names strictly through search_path; other dialects are
    // usually single-schema scripts, so fall back to a unique match by name.
    if (this.dialect === 'postgres') return undefined;
    const byName = this.tables.filter((t) => t.name.toLowerCase() === nm);
    return byName.length === 1 ? byName[0] : undefined;
  }

  creationSchema(ref: TableRef): string {
    if (ref.schema !== undefined) return ref.schema;
    return this.searchPath[0] ?? '';
  }

  uniqueId(base: string): string {
    let id = base;
    let k = 2;
    while (this.usedIds.has(id)) id = `${base}#${k++}`;
    this.usedIds.add(id);
    return id;
  }

  newTable(schema: string, name: string): Table {
    const t: Table = {
      id: this.uniqueId(`t:${schema}.${name}`.toLowerCase()),
      schema,
      name,
      columns: [],
    };
    this.tables.push(t);
    return t;
  }

  newColumn(t: Table, name: string): Column {
    return {
      id: this.uniqueId(`${t.id}:${name.toLowerCase()}`),
      name,
      type: '',
      nullable: true,
      pk: false,
      unique: false,
    };
  }

  col(t: Table, name: string): Column | undefined {
    const nm = name.toLowerCase();
    return t.columns.find((c) => c.name.toLowerCase() === nm);
  }

  dropTable(t: Table) {
    this.tables = this.tables.filter((x) => x !== t);
    this.fks = this.fks.filter((f) => f.from !== t && f.to !== t);
  }

  dropColumn(t: Table, c: Column) {
    t.columns = t.columns.filter((x) => x !== c);
    this.fks = this.fks.filter((f) => !f.fromCols.includes(c) && !f.toCols.includes(c));
    if (t.uniques) t.uniques = t.uniques.filter((u) => !u.columns.includes(c.id));
  }

  // ---- statement dispatch ---------------------------------------------

  statement(toks: Tok[]) {
    if (!toks.length) return;
    const c = new Cur(toks);
    const first = toks[0];
    if (first.k !== 'word') return;
    try {
      switch (first.u) {
        case 'CREATE':
          return this.create(c);
        case 'ALTER':
          if (c.is('TABLE', 1)) return this.alterTable(c);
          if (c.is('TYPE', 1)) return this.alterType(c);
          return;
        case 'DROP':
          if (c.is('TABLE', 1)) return this.dropTables(c);
          if (c.is('TYPE', 1) || c.is('DOMAIN', 1)) return this.dropType(c);
          return;
        case 'COMMENT':
          return this.comment(c);
        case 'SET':
          return this.set(c);
        case 'DO':
          return this.doBlock(c);
        case 'IF':
        case 'BEGIN':
        case 'ELSE':
          return this.embedded(toks);
        default:
          return;
      }
    } catch (e) {
      this.warn(`could not parse statement "${joinTokens(toks.slice(0, 8))} …": ${(e as Error).message}`);
    }
  }

  /** Find DDL embedded in control-flow (DO blocks, T-SQL IF ... BEGIN ... END). */
  embedded(toks: Tok[]) {
    const prev = this.conditional;
    this.conditional = true;
    try {
      this.embeddedInner(toks);
    } finally {
      this.conditional = prev;
    }
  }

  private embeddedInner(toks: Tok[]) {
    for (let i = 1; i < toks.length; i++) {
      const t = toks[i];
      if (t.k !== 'word') continue;
      const n1 = toks[i + 1];
      const n2 = toks[i + 2];
      const isTable = n1 && n1.k === 'word' && (n1.u === 'TABLE' || n1.u === 'TYPE' || n1.u === 'DOMAIN');
      if (
        (t.u === 'CREATE' && (isTable || (n1?.u === 'UNIQUE' && n2?.u === 'INDEX'))) ||
        (t.u === 'ALTER' && isTable && n1.u !== 'DOMAIN') ||
        (t.u === 'DROP' && isTable) ||
        (t.u === 'COMMENT' && n1?.u === 'ON')
      ) {
        this.statement(toks.slice(i));
        return;
      }
    }
  }

  doBlock(c: Cur) {
    c.next(); // DO
    if (c.is('LANGUAGE')) {
      c.next();
      c.next();
    }
    const body = c.peek();
    if (!body || (body.k !== 'dollar' && body.k !== 'string')) return;
    const inner = splitStatements(tokenize(body.v));
    const prev = this.conditional;
    this.conditional = true;
    // IF/ELSIF/ELSE frames. Conditions we can evaluate against the model (to_regclass checks)
    // gate their branches; anything else is assumed true so idempotency guards still apply DDL.
    const frames: { active: boolean; taken: boolean; known: boolean }[] = [];
    const live = () => frames.every((f) => f.active);
    try {
      for (const st of inner) {
        let i = 0;
        const at = (k: number, w: string) => st[k]?.k === 'word' && st[k].u === w;
        for (;;) {
          while (at(i, 'BEGIN') || at(i, 'DECLARE')) i++;
          if (at(i, 'END') && at(i + 1, 'IF')) {
            frames.pop();
            i += 2;
            continue;
          }
          if (at(i, 'IF') || at(i, 'ELSIF') || at(i, 'ELSEIF')) {
            const isIf = at(i, 'IF');
            const then = st.findIndex((t, k) => k > i && t.k === 'word' && t.u === 'THEN');
            if (then < 0) break;
            const cond = this.evalCondition(st.slice(i + 1, then));
            if (isIf) frames.push({ active: cond ?? true, taken: cond ?? false, known: cond !== undefined });
            else if (frames.length) {
              const f = frames[frames.length - 1];
              f.active = f.known && f.taken ? false : (cond ?? true);
              f.taken = f.taken || cond === true;
              f.known = f.known && cond !== undefined;
            }
            i = then + 1;
            continue;
          }
          if (at(i, 'ELSE')) {
            const f = frames[frames.length - 1];
            if (f) f.active = f.known ? !f.taken : true;
            i++;
            continue;
          }
          break;
        }
        const rest = st.slice(i);
        if (!rest.length || !live()) continue;
        if (rest[0].k === 'word' && (rest[0].u === 'EXCEPTION' || rest[0].u === 'END')) continue;
        if (rest[0].k === 'word' && ['CREATE', 'ALTER', 'DROP', 'COMMENT'].includes(rest[0].u)) this.statement(rest);
        else this.embedded(rest);
      }
    } finally {
      this.conditional = prev;
    }
  }

  /** Evaluate `to_regclass('x') IS [NOT] NULL` (optionally negated); undefined when unknown. */
  evalCondition(toks: Tok[]): boolean | undefined {
    const c = new Cur(toks);
    let negate = false;
    while (c.accept('NOT')) negate = !negate;
    if (c.isPunct('(') && matchParen(toks, c.i) === toks.length - 1) {
      // strip wrapping parentheses
      const r = this.evalCondition(toks.slice(c.i + 1, toks.length - 1));
      return r === undefined ? r : negate ? !r : r;
    }
    if (!(c.peek()?.k === 'word' && /^(PG_CATALOG\.)?TO_REGCLASS$/.test(c.peek()!.u))) return undefined;
    c.next();
    const args = c.parens();
    if (!args || args.length < 1 || args[0].k !== 'string') return undefined;
    const rest = c.rest().filter((t) => !(t.k === 'op' && t.v === '::') && !(t.k === 'word' && (t.u === 'TEXT' || t.u === 'REGCLASS')));
    const words = rest.map((t) => t.u).join(' ');
    let exists: boolean;
    const parts = args[0].v.split('.').map((p) => p.replace(/^"|"$/g, ''));
    const found = !!this.find(this.refFromParts(parts));
    if (words === 'IS NOT NULL') exists = found;
    else if (words === 'IS NULL') exists = !found;
    else return undefined;
    return negate ? !exists : exists;
  }

  set(c: Cur) {
    c.next(); // SET
    if (c.accept('SESSION') || c.accept('LOCAL')) {
      /* noop */
    }
    if (c.is('SEARCH_PATH')) {
      c.next();
      if (!c.accept('TO')) c.next(); // '=' operator
      const items = splitTopLevel(c.rest())
        .map((p) => p[0])
        .filter((t): t is Tok => !!t)
        .map((t) => t.v)
        .filter((v) => v.toLowerCase() !== '$user' && v.toUpperCase() !== 'DEFAULT');
      this.searchPath = items.length ? items : [defaultSchemaFor(this.dialect)];
    } else if (c.is('SCHEMA')) {
      c.next();
      const t = c.next();
      if (t) this.searchPath = [t.v];
    }
  }

  // ---- CREATE ----------------------------------------------------------

  create(c: Cur) {
    c.next(); // CREATE
    c.accept('OR', 'REPLACE');
    let temp = false;
    let unique = false;
    for (;;) {
      if (c.isAny(['GLOBAL', 'LOCAL'])) c.next();
      else if (c.isAny(['TEMP', 'TEMPORARY'])) {
        temp = true;
        c.next();
      } else if (c.isAny(['UNLOGGED', 'VIRTUAL'])) c.next();
      else if (c.is('UNIQUE')) {
        unique = true;
        c.next();
      } else if (c.isAny(['CLUSTERED', 'NONCLUSTERED'])) c.next();
      else break;
    }
    if (c.is('TABLE')) {
      c.next();
      if (temp) return;
      return this.createTable(c);
    }
    if (c.is('INDEX') && unique) {
      c.next();
      return this.createUniqueIndex(c);
    }
    if (c.is('TYPE') || c.is('DOMAIN')) {
      const kind = c.next()!.u === 'TYPE' ? 'type' : 'domain';
      return this.createType(c, kind);
    }
  }

  // ---- user-defined types (enums, domains) ------------------------------

  findType(parts: string[]): UserType | undefined {
    const ref = this.refFromParts(parts);
    const nm = ref.name.toLowerCase();
    const schemas = ref.schema !== undefined ? [ref.schema] : this.searchPath;
    for (const s of schemas) {
      const hit = this.types.find((t) => t.name.toLowerCase() === nm && t.schema.toLowerCase() === s.toLowerCase());
      if (hit) return hit;
    }
    return ref.schema === undefined ? this.types.find((t) => t.name.toLowerCase() === nm) : undefined;
  }

  createType(c: Cur, kind: 'type' | 'domain') {
    const parts = c.qname();
    if (!parts) return;
    if (this.findType(parts)) return; // already defined (idempotent DO blocks)
    const ref = this.refFromParts(parts);
    const schema = this.creationSchema(ref);
    if (kind === 'type') {
      if (!c.accept('AS', 'ENUM')) return; // composite/range types are not used as column types here
      const inner = c.parens() ?? [];
      const values = inner.filter((t) => t.k === 'string').map((t) => t.v);
      this.types.push({ schema, name: ref.name, kind: 'enum', values });
    } else {
      const rest = c.rest();
      if (!rest.length) return;
      this.types.push({ schema, name: ref.name, kind: 'domain', definition: joinTokens(rest) });
    }
  }

  alterType(c: Cur) {
    c.i += 2; // ALTER TYPE
    const parts = c.qname();
    const t = parts && this.findType(parts);
    if (!t) return;
    if (c.accept('ADD', 'VALUE')) {
      c.accept('IF', 'NOT', 'EXISTS');
      const v = c.next();
      if (v?.k !== 'string' || !t.values || t.values.includes(v.v)) return;
      const where = c.next()?.u;
      const anchor = c.next();
      const idx = anchor?.k === 'string' ? t.values.indexOf(anchor.v) : -1;
      if (idx >= 0 && where === 'BEFORE') t.values.splice(idx, 0, v.v);
      else if (idx >= 0 && where === 'AFTER') t.values.splice(idx + 1, 0, v.v);
      else t.values.push(v.v);
    } else if (c.accept('RENAME', 'VALUE')) {
      const from = c.next();
      c.accept('TO');
      const to = c.next();
      if (t.values && from && to) t.values = t.values.map((x) => (x === from.v ? to.v : x));
    } else if (c.accept('RENAME', 'TO')) {
      const n = c.ident();
      if (n) t.name = n;
    } else if (c.accept('SET', 'SCHEMA')) {
      const s = c.ident();
      if (s) t.schema = s;
    }
  }

  dropType(c: Cur) {
    c.i += 2; // DROP TYPE / DOMAIN
    c.accept('IF', 'EXISTS');
    for (const part of splitTopLevel(c.rest())) {
      const parts = new Cur(part).qname();
      const t = parts && this.findType(parts);
      if (t) this.types = this.types.filter((x) => x !== t);
    }
  }

  createTable(c: Cur) {
    const ifNotExists = c.accept('IF', 'NOT', 'EXISTS');
    const parts = c.qname();
    if (!parts) return;
    const ref = this.refFromParts(parts);
    if (c.is('PARTITION') || c.is('AS') || c.is('OF')) return; // partitions / CTAS / typed tables
    if (!c.isPunct('(')) {
      if (c.is('AS')) this.warn(`CREATE TABLE ${parts.join('.')} AS … skipped`);
      return;
    }
    const existing = this.find(ref.schema === undefined ? { schema: this.searchPath[0], name: ref.name } : ref);
    if (existing) {
      if (!ifNotExists && !this.conditional) this.warn(`table ${parts.join('.')} created twice; keeping the first definition`);
      return;
    }
    const table = this.newTable(this.creationSchema(ref), ref.name);
    const inner = c.parens() ?? [];
    for (const el of splitTopLevel(inner)) this.tableElement(table, el);
    // MySQL table options: COMMENT='...'
    while (!c.eof) {
      if (c.is('COMMENT')) {
        c.next();
        if (c.peek()?.v === '=') c.next();
        const s = c.next();
        if (s?.k === 'string') table.comment = s.v;
      } else c.next();
    }
  }

  tableElement(table: Table, el: Tok[]) {
    if (!el.length) return;
    const head = el[0];
    if (head.k === 'word') {
      if (TABLE_CONSTRAINT_START.has(head.u)) return this.tableConstraint(table, new Cur(el));
      if (this.dialect === 'mysql' && MYSQL_INDEX_START.has(head.u)) return; // plain index
      if (head.u === 'LIKE') return this.likeClause(table, new Cur(el));
      if (head.u === 'INDEX' && el[2]?.v === '(') return; // T-SQL inline index
    }
    this.addColumnFromDef(table, el, false);
  }

  likeClause(table: Table, c: Cur) {
    c.next();
    const parts = c.qname();
    if (!parts) return;
    const src = this.find(this.refFromParts(parts));
    if (!src) return;
    for (const col of src.columns) {
      if (this.col(table, col.name)) continue;
      const nc = this.newColumn(table, col.name);
      Object.assign(nc, { ...col, id: nc.id, pk: false, unique: false });
      table.columns.push(nc);
    }
  }

  /** Parse "name type [constraints...]" and add (or replace) the column. */
  addColumnFromDef(table: Table, el: Tok[], ifNotExists: boolean): Column | undefined {
    const c = new Cur(el);
    const name = c.ident();
    if (name === undefined) return;
    const existing = this.col(table, name);
    if (existing) {
      if (!ifNotExists && !this.conditional) this.warn(`column ${table.name}.${name} added twice`);
      return existing;
    }
    const col = this.newColumn(table, name);
    table.columns.push(col);
    this.columnBody(table, col, c);
    return col;
  }

  /** Parse the type and inline constraints of a column definition. */
  columnBody(table: Table, col: Column, c: Cur, typeOptional = false) {
    // Type: tokens until a terminator keyword at depth 0.
    const typeToks: Tok[] = [];
    while (!c.eof) {
      const t = c.peek()!;
      if (t.k === 'word' && COLUMN_TERMINATORS.has(t.u)) break;
      if (t.k === 'word' && t.u === 'CHARACTER' && c.is('SET', 1)) break;
      if (t.k === 'word' && (t.u === 'CHARSET' || t.u === 'USING')) break;
      if (t.k === 'punct' && t.v === '(') {
        const close = matchParen(c.t, c.i);
        typeToks.push(...c.t.slice(c.i, close + 1));
        c.i = close + 1;
        continue;
      }
      typeToks.push(t);
      c.next();
    }
    if (typeToks.length || !typeOptional) {
      col.type = joinTokens(typeToks, true) || col.type || '';
      if (/^(big|small)?serial[248]?$/.test(col.type)) col.identity = true;
    }
    this.columnConstraints(table, col, c);
  }

  columnConstraints(table: Table, col: Column, c: Cur) {
    let constraintName: string | undefined;
    while (!c.eof) {
      if (c.accept('CONSTRAINT')) {
        constraintName = c.ident();
        continue;
      }
      if (c.accept('NOT', 'NULL')) {
        col.nullable = false;
        continue;
      }
      if (c.accept('NOT', 'FOR', 'REPLICATION')) continue;
      if (c.is('NOT') && (c.is('DEFERRABLE', 1) || c.is('VALID', 1))) {
        c.i += 2;
        continue;
      }
      if (c.accept('NULL')) {
        col.nullable = true;
        continue;
      }
      if (c.accept('DEFAULT')) {
        const d: Tok[] = [];
        while (!c.eof) {
          const t = c.peek()!;
          if (t.k === 'word' && COLUMN_TERMINATORS.has(t.u) && t.u !== 'NULL' && t.u !== 'ON') break;
          if (t.k === 'word' && t.u === 'NOT' && c.is('NULL', 1)) break;
          if (t.k === 'word' && t.u === 'ON' && c.is('UPDATE', 1)) break;
          if (t.k === 'word' && t.u === 'FOR' && d.length) break; // T-SQL DEFAULT x FOR col
          if (t.k === 'punct' && t.v === '(') {
            const close = matchParen(c.t, c.i);
            d.push(...c.t.slice(c.i, close + 1));
            c.i = close + 1;
            continue;
          }
          d.push(t);
          c.next();
        }
        col.default = joinTokens(d);
        continue;
      }
      if (c.accept('PRIMARY', 'KEY')) {
        col.pk = true;
        col.nullable = false;
        if (constraintName) table.pkName = constraintName;
        constraintName = undefined;
        while (c.isAny(['ASC', 'DESC', 'CLUSTERED', 'NONCLUSTERED'])) c.next();
        if (c.is('AUTOINCREMENT')) {
          col.identity = true;
          c.next();
        }
        continue;
      }
      if (c.accept('UNIQUE')) {
        col.unique = true;
        while (c.isAny(['KEY', 'CLUSTERED', 'NONCLUSTERED'])) c.next();
        if (c.accept('NULLS')) {
          c.accept('NOT');
          c.accept('DISTINCT');
        }
        if (constraintName) (table.uniqueNames ??= {})[col.id] = constraintName;
        constraintName = undefined;
        continue;
      }
      if (c.is('REFERENCES')) {
        c.next();
        this.references(table, [col], c, constraintName);
        constraintName = undefined;
        continue;
      }
      if (c.accept('CHECK')) {
        c.parens();
        c.accept('NO', 'INHERIT');
        constraintName = undefined;
        continue;
      }
      if (c.accept('GENERATED')) {
        if (c.accept('ALWAYS') || c.accept('BY', 'DEFAULT')) {
          /* noop */
        }
        if (c.accept('AS', 'IDENTITY')) {
          col.identity = true;
          c.parens();
          continue;
        }
        if (c.accept('AS')) {
          const expr = c.parens();
          if (expr) col.default = `GENERATED ALWAYS AS (${joinTokens(expr)}) STORED`;
          c.accept('STORED');
          c.accept('VIRTUAL');
        }
        continue;
      }
      if (c.accept('AS')) {
        // T-SQL computed column / MySQL generated column without GENERATED keyword
        const expr = c.parens();
        if (expr) col.default = `GENERATED ALWAYS AS (${joinTokens(expr)}) STORED`;
        if (!col.type) col.type = 'computed';
        c.accept('PERSISTED');
        continue;
      }
      if (c.accept('IDENTITY')) {
        col.identity = true;
        c.parens();
        continue;
      }
      if (c.accept('AUTO_INCREMENT') || c.accept('AUTOINCREMENT')) {
        col.identity = true;
        continue;
      }
      if (c.accept('COLLATE')) {
        c.qname();
        continue;
      }
      if (c.accept('COMMENT')) {
        const s = c.next();
        if (s?.k === 'string') col.comment = s.v;
        continue;
      }
      if (c.accept('ON', 'UPDATE')) {
        c.next();
        c.parens();
        continue;
      }
      c.next();
    }
  }

  references(table: Table, fromCols: Column[], c: Cur, name?: string) {
    const parts = c.qname();
    if (!parts) return;
    const ref = this.refFromParts(parts);
    const toNames = columnList(c.parens());
    let onDelete: FkAction | undefined;
    let onUpdate: FkAction | undefined;
    while (!c.eof) {
      if (c.accept('ON', 'DELETE')) onDelete = parseAction(c);
      else if (c.accept('ON', 'UPDATE')) onUpdate = parseAction(c);
      else if (c.accept('MATCH')) c.next();
      else if (c.accept('NOT', 'DEFERRABLE') || c.accept('DEFERRABLE')) {
        /* noop */
      } else if (c.accept('INITIALLY')) c.next();
      else if (c.accept('NOT', 'FOR', 'REPLICATION')) {
        /* noop */
      } else if (c.accept('NOT', 'VALID')) {
        /* noop */
      } else break;
    }
    const target: Table | TableRef = this.find(ref) ?? ref;
    const toCols: (Column | string)[] = toNames.map((n) =>
      'columns' in target ? this.col(target as Table, n) ?? n : n,
    );
    const fkName = name ?? `${table.name}_${fromCols.map((x) => x.name).join('_')}_fkey`;
    // Replace an existing identical FK (idempotent migrations add the same FK again).
    this.fks = this.fks.filter(
      (f) => !(f.from === table && f.fromCols.length === fromCols.length && f.fromCols.every((x, i) => x === fromCols[i])),
    );
    this.fks.push({ name: fkName, from: table, fromCols, to: target, toCols, onDelete, onUpdate });
  }

  tableConstraint(table: Table, c: Cur) {
    let name: string | undefined;
    if (c.accept('CONSTRAINT')) name = c.ident();
    if (c.accept('PRIMARY', 'KEY')) {
      while (c.isAny(['CLUSTERED', 'NONCLUSTERED'])) c.next();
      const names = columnList(c.parens());
      for (const col of table.columns) col.pk = false;
      for (const n of names) {
        const col = this.col(table, n);
        if (col) {
          col.pk = true;
          col.nullable = false;
        }
      }
      if (name) table.pkName = name;
      return;
    }
    if (c.accept('UNIQUE')) {
      while (c.isAny(['KEY', 'INDEX', 'CLUSTERED', 'NONCLUSTERED'])) c.next();
      if (c.accept('NULLS')) {
        c.accept('NOT');
        c.accept('DISTINCT');
      }
      if (!c.isPunct('(') && c.isIdent()) name = name ?? c.ident(); // MySQL: UNIQUE KEY name (cols)
      const names = columnList(c.parens());
      const cols = names.map((n) => this.col(table, n)).filter((x): x is Column => !!x);
      if (cols.length === 1) {
        cols[0].unique = true;
        if (name) (table.uniqueNames ??= {})[cols[0].id] = name;
      } else if (cols.length > 1) {
        (table.uniques ??= []).push({ name, columns: cols.map((x) => x.id) });
      }
      return;
    }
    if (c.accept('FOREIGN', 'KEY')) {
      if (!c.isPunct('(') && c.isIdent()) name = name ?? c.ident(); // MySQL: FOREIGN KEY name (cols)
      const names = columnList(c.parens());
      const cols = names.map((n) => this.col(table, n));
      if (cols.some((x) => !x)) {
        this.warn(`foreign key on ${table.name}(${names.join(', ')}) references unknown column(s)`);
        return;
      }
      if (!c.accept('REFERENCES')) return;
      this.references(table, cols as Column[], c, name);
      return;
    }
    if (c.accept('DEFAULT')) {
      // T-SQL: CONSTRAINT df DEFAULT (expr) FOR col
      const d: Tok[] = [];
      while (!c.eof && !c.is('FOR')) d.push(c.next()!);
      if (c.accept('FOR')) {
        const cn = c.ident();
        const col = cn ? this.col(table, cn) : undefined;
        if (col) col.default = joinTokens(d);
      }
      return;
    }
    // CHECK / EXCLUDE: not represented in the diagram
  }

  createUniqueIndex(c: Cur) {
    c.accept('CONCURRENTLY');
    c.accept('IF', 'NOT', 'EXISTS');
    let indexName: string | undefined;
    if (!c.is('ON')) indexName = c.qname()?.pop();
    if (!c.accept('ON')) return;
    c.accept('ONLY');
    const parts = c.qname();
    if (!parts) return;
    const table = this.find(this.refFromParts(parts));
    if (!table) return;
    if (c.accept('USING')) c.next();
    const inner = c.parens();
    if (!inner) return;
    // A partial unique index (WHERE ...) does not make the column unique on its own.
    const rest = c.rest();
    if (rest.some((t) => t.k === 'word' && t.u === 'WHERE')) return;
    const items = splitTopLevel(inner);
    const names = columnList(inner);
    if (names.length !== items.length) return; // expression index
    const cols = names.map((n) => this.col(table, n)).filter((x): x is Column => !!x);
    if (cols.length === 1) {
      cols[0].unique = true;
      if (indexName) (table.uniqueIndexes ??= {})[cols[0].id] = indexName;
    } else if (cols.length > 1) {
      (table.uniques ??= []).push({ name: indexName, columns: cols.map((x) => x.id) });
    }
  }

  // ---- DROP ------------------------------------------------------------

  dropTables(c: Cur) {
    c.i += 2; // DROP TABLE
    c.accept('IF', 'EXISTS');
    for (const part of splitTopLevel(c.rest())) {
      const pc = new Cur(part);
      const parts = pc.qname();
      if (!parts) continue;
      const t = this.find(this.refFromParts(parts));
      if (t) this.dropTable(t);
    }
  }

  // ---- COMMENT ON ------------------------------------------------------

  comment(c: Cur) {
    c.next();
    if (!c.accept('ON')) return;
    if (c.accept('TABLE')) {
      const parts = c.qname();
      if (!parts || !c.accept('IS')) return;
      const t = this.find(this.refFromParts(parts));
      const s = c.next();
      if (t) t.comment = s?.k === 'string' || s?.k === 'dollar' ? s.v : undefined;
    } else if (c.accept('COLUMN')) {
      const parts = c.qname();
      if (!parts || parts.length < 2 || !c.accept('IS')) return;
      const colName = parts.pop()!;
      const t = this.find(this.refFromParts(parts));
      const s = c.next();
      const col = t && this.col(t, colName);
      if (col) col.comment = s?.k === 'string' || s?.k === 'dollar' ? s.v : undefined;
    }
  }

  // ---- ALTER TABLE -----------------------------------------------------

  alterTable(c: Cur) {
    c.i += 2; // ALTER TABLE
    c.accept('IF', 'EXISTS');
    c.accept('ONLY');
    const parts = c.qname();
    if (!parts) return;
    if (c.peek()?.v === '*') c.next();
    // T-SQL: ALTER TABLE t WITH [NO]CHECK ADD CONSTRAINT ...
    if (c.accept('WITH', 'CHECK') || c.accept('WITH', 'NOCHECK')) {
      /* noop */
    }
    const table = this.find(this.refFromParts(parts));
    if (!table) return; // table unknown (maybe created by something we skip)
    let lastWasAddColumn = false;
    for (const action of splitTopLevel(c.rest())) {
      if (!action.length) continue;
      const a = new Cur(action);
      if (a.accept('ADD')) {
        if (a.isAny(TABLE_CONSTRAINT_START)) {
          this.tableConstraint(table, a);
          lastWasAddColumn = false;
          continue;
        }
        if (this.dialect === 'mysql' && a.isAny(MYSQL_INDEX_START)) continue;
        a.accept('COLUMN');
        const ine = a.accept('IF', 'NOT', 'EXISTS');
        this.addColumnFromDef(table, a.rest(), ine);
        lastWasAddColumn = true;
        continue;
      }
      if (a.accept('DROP')) {
        lastWasAddColumn = false;
        if (a.accept('CONSTRAINT')) {
          a.accept('IF', 'EXISTS');
          const nm = a.ident();
          if (nm) this.dropConstraint(table, nm);
          continue;
        }
        if (a.accept('PRIMARY', 'KEY')) {
          for (const col of table.columns) col.pk = false;
          continue;
        }
        if (a.accept('FOREIGN', 'KEY')) {
          const nm = a.ident();
          if (nm) this.dropConstraint(table, nm);
          continue;
        }
        if (a.isAny(['INDEX', 'KEY', 'DEFAULT', 'CHECK', 'PERIOD'])) continue;
        a.accept('COLUMN');
        a.accept('IF', 'EXISTS');
        const nm = a.ident();
        const col = nm ? this.col(table, nm) : undefined;
        if (col) this.dropColumn(table, col);
        continue;
      }
      if (a.accept('RENAME')) {
        lastWasAddColumn = false;
        if (a.accept('TO') || a.accept('AS')) {
          const np = a.qname();
          if (np) table.name = np[np.length - 1];
          continue;
        }
        if (a.accept('CONSTRAINT')) {
          const from = a.ident();
          a.accept('TO');
          const to = a.ident();
          if (from && to) this.renameConstraint(table, from, to);
          continue;
        }
        a.accept('COLUMN');
        const from = a.ident();
        a.accept('TO');
        const to = a.ident();
        const col = from ? this.col(table, from) : undefined;
        if (col && to) col.name = to;
        continue;
      }
      if (a.accept('ALTER')) {
        lastWasAddColumn = false;
        a.accept('COLUMN');
        const nm = a.ident();
        const col = nm ? this.col(table, nm) : undefined;
        if (!col) continue;
        this.alterColumn(table, col, a);
        continue;
      }
      if (a.accept('MODIFY')) {
        // MySQL: MODIFY [COLUMN] name type ...
        a.accept('COLUMN');
        const nm = a.ident();
        const col = nm ? this.col(table, nm) : undefined;
        if (col) {
          col.nullable = true;
          this.columnBody(table, col, a);
        }
        continue;
      }
      if (a.accept('CHANGE')) {
        // MySQL: CHANGE [COLUMN] old new type ...
        a.accept('COLUMN');
        const from = a.ident();
        const to = a.ident();
        const col = from ? this.col(table, from) : undefined;
        if (col && to) {
          col.name = to;
          col.nullable = true;
          this.columnBody(table, col, a);
        }
        continue;
      }
      if (a.accept('SET', 'SCHEMA')) {
        const s = a.ident();
        if (s) table.schema = s;
        continue;
      }
      if (lastWasAddColumn && a.isIdent() && !a.isAny(['ENABLE', 'DISABLE', 'OWNER', 'SET', 'RESET', 'CLUSTER', 'INHERIT', 'NO', 'REPLICA', 'FORCE', 'VALIDATE', 'ATTACH', 'DETACH', 'OF', 'NOT'])) {
        // T-SQL: ALTER TABLE t ADD a int, b int
        if (a.isAny(TABLE_CONSTRAINT_START)) this.tableConstraint(table, a);
        else this.addColumnFromDef(table, action, false);
        continue;
      }
      // OWNER TO, ENABLE ROW LEVEL SECURITY, SET (...), etc. — not relevant
      lastWasAddColumn = false;
    }
  }

  alterColumn(table: Table, col: Column, a: Cur) {
    if (a.accept('SET', 'DATA', 'TYPE') || a.accept('TYPE')) {
      const toks: Tok[] = [];
      while (!a.eof && !a.isAny(['USING', 'COLLATE'])) toks.push(a.next()!);
      col.type = joinTokens(toks, true);
      return;
    }
    if (a.accept('SET', 'NOT', 'NULL')) {
      col.nullable = false;
      return;
    }
    if (a.accept('DROP', 'NOT', 'NULL')) {
      col.nullable = true;
      return;
    }
    if (a.accept('SET', 'DEFAULT')) {
      col.default = joinTokens(a.rest());
      return;
    }
    if (a.accept('DROP', 'DEFAULT')) {
      col.default = undefined;
      return;
    }
    if (a.accept('ADD', 'GENERATED')) {
      col.identity = true;
      return;
    }
    if (a.accept('DROP', 'IDENTITY')) {
      col.identity = false;
      return;
    }
    if (a.isAny(['SET', 'DROP', 'RESET', 'ADD', 'OPTIONS'])) return; // SET STATISTICS / STORAGE, etc.
    // T-SQL: ALTER COLUMN name type [NULL | NOT NULL]
    col.nullable = true;
    this.columnBody(table, col, a);
  }

  dropConstraint(table: Table, name: string) {
    const nm = name.toLowerCase();
    const before = this.fks.length;
    this.fks = this.fks.filter((f) => !(f.from === table && f.name.toLowerCase() === nm));
    if (this.fks.length !== before) return;
    const pkName = (table.pkName ?? `${table.name}_pkey`).toLowerCase();
    if (pkName === nm) {
      for (const col of table.columns) col.pk = false;
      return;
    }
    if (table.uniqueNames) {
      for (const [colId, un] of Object.entries(table.uniqueNames)) {
        if (un.toLowerCase() === nm) {
          const col = table.columns.find((x) => x.id === colId);
          if (col) col.unique = false;
          delete table.uniqueNames[colId];
          return;
        }
      }
    }
    // PG default name for single-column unique constraints: <table>_<col>_key
    for (const col of table.columns) {
      if (col.unique && `${table.name}_${col.name}_key`.toLowerCase() === nm) {
        col.unique = false;
        return;
      }
    }
    if (table.uniques) {
      table.uniques = table.uniques.filter((u) => {
        const auto = `${table.name}_${u.columns
          .map((id) => table.columns.find((x) => x.id === id)?.name ?? '')
          .join('_')}_key`.toLowerCase();
        return !(u.name?.toLowerCase() === nm || auto === nm);
      });
    }
  }

  renameConstraint(table: Table, from: string, to: string) {
    const nm = from.toLowerCase();
    for (const f of this.fks) if (f.from === table && f.name.toLowerCase() === nm) f.name = to;
    if ((table.pkName ?? `${table.name}_pkey`).toLowerCase() === nm) table.pkName = to;
    if (table.uniqueNames)
      for (const k of Object.keys(table.uniqueNames)) if (table.uniqueNames[k].toLowerCase() === nm) table.uniqueNames[k] = to;
  }

  // ---- finalize --------------------------------------------------------

  finish(): Schema {
    const relations: Relation[] = [];
    const used = new Set<string>();
    for (const f of this.fks) {
      const to = 'columns' in f.to ? (f.to as Table) : this.find(f.to as TableRef);
      if (!to || !this.tables.includes(to)) {
        const tr = f.to as TableRef;
        this.warn(`foreign key ${f.name}: referenced table ${tr.schema ? tr.schema + '.' : ''}${tr.name} not found`);
        continue;
      }
      let toCols: (Column | undefined)[];
      if (f.toCols.length === 0) toCols = to.columns.filter((x) => x.pk);
      else toCols = f.toCols.map((x) => (typeof x === 'string' ? this.col(to, x) : to.columns.includes(x) ? x : undefined));
      if (toCols.length !== f.fromCols.length || toCols.some((x) => !x)) {
        this.warn(`foreign key ${f.name}: could not resolve referenced column(s) on ${to.name}`);
        continue;
      }
      let id = `r:${f.from.id}>${f.fromCols.map((x) => x.name.toLowerCase()).join(',')}`;
      let k = 2;
      while (used.has(id)) id = `${id}#${k++}`;
      used.add(id);
      relations.push({
        id,
        name: f.name,
        fromTable: f.from.id,
        fromColumns: f.fromCols.map((x) => x.id),
        toTable: to.id,
        toColumns: (toCols as Column[]).map((x) => x.id),
        onDelete: f.onDelete,
        onUpdate: f.onUpdate,
      });
    }
    return { dialect: this.dialect, tables: this.tables, relations, ...(this.types.length ? { types: this.types } : {}) };
  }
}

/** Replay the given SQL scripts in order and return the resulting schema. */
export function parseSql(files: SourceFile[], opts: ParseOptions = {}): ParseResult {
  const dialect = opts.dialect ?? detectDialect(files.map((f) => f.content).join('\n'));
  const b = new Builder(dialect);
  for (const f of files) {
    b.resetFile(f.name);
    let toks: Tok[];
    try {
      toks = tokenize(f.content);
    } catch (e) {
      b.warn(`tokenizer failed: ${(e as Error).message}`);
      continue;
    }
    for (const st of splitStatements(toks)) b.statement(st);
  }
  return { schema: b.finish(), warnings: b.warnings, dialect };
}
