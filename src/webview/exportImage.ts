// Image export. The diagram is drawn directly as SVG from the schema and table positions (not a DOM
// snapshot): small files, crisp at any zoom, opens in browsers and vector editors. PNG = that SVG
// rasterised at high resolution.

import { Position as Side, getSmoothStepPath } from '@xyflow/react';
import { Box, edgeSides, edgeSidesFor } from './edgeGeometry';
import { Rect, roundedPath, routeOrthogonal } from './router';
import type { GroupBox } from './groups';
import { Relation, Table } from '../shared/model';
import { HEADER_HEIGHT, NODE_WIDTH, ROW_HEIGHT, nodeHeight } from './layout';

export type { Box } from './edgeGeometry';

export interface Palette {
  bg: string;
  card: string;
  header: string;
  border: string;
  fg: string;
  muted: string;
  pk: string;
  fk: string;
  edge: string;
}

export const LIGHT: Palette = {
  bg: '#ffffff',
  card: '#ffffff',
  header: '#f1f3f5',
  border: '#c9ced4',
  fg: '#1f2328',
  muted: '#6b7280',
  pk: '#b07d00',
  fk: '#0969da',
  edge: '#8b949e',
};

export const DARK: Palette = {
  bg: '#1e1e1e',
  card: '#252526',
  header: '#2d2d30',
  border: '#454545',
  fg: '#d4d4d4',
  muted: '#9d9d9d',
  pk: '#e2c08d',
  fk: '#4fc1ff',
  edge: '#7a7a7a',
};

export { edgeSides } from './edgeGeometry';

const FONT = `'Segoe UI', system-ui, -apple-system, Roboto, sans-serif`;
const MONO = `Consolas, Menlo, 'DejaVu Sans Mono', monospace`;
const COL_TOP = HEADER_HEIGHT + 3;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

let measureCtx: CanvasRenderingContext2D | null = null;
function fit(text: string, font: string, max: number): string {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text;
  measureCtx.font = font;
  if (measureCtx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measureCtx.measureText(text.slice(0, mid) + '…').width <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

// 16×16 icon paths (same shapes as the live diagram).
const ICON = {
  key: '<circle cx="5" cy="11" r="3"/><path d="M7.2 8.8 13.5 2.5M11 5l2 2M12.6 3.4l1.6 1.6"/>',
  link: '<path d="M6.5 9.5l3-3"/><path d="M7.5 4.5 9 3a2.8 2.8 0 0 1 4 4l-1.5 1.5"/><path d="M8.5 11.5 7 13a2.8 2.8 0 0 1-4-4l1.5-1.5"/>',
  diamond: '<path d="M8 2.5 13.5 8 8 13.5 2.5 8Z"/>',
};

function icon(kind: keyof typeof ICON, x: number, y: number, color: string, size = 12, fill = 'none'): string {
  const s = size / 16;
  return `<g transform="translate(${x} ${y}) scale(${s})" fill="${fill}" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICON[kind]}</g>`;
}

export interface SvgInput {
  tables: Table[];
  relations: Relation[];
  boxes: Map<string, Box>;
  palette: Palette;
  title?: string;
  /** Route lines around tables (default true). */
  routing?: boolean;
  groups?: GroupBox[];
}

export function buildSvg(input: SvgInput): { svg: string; width: number; height: number } {
  const { tables, relations, boxes, palette: p, title } = input;
  const PAD = 48;
  const shown = tables.filter((t) => boxes.has(t.id));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of shown) {
    const b = boxes.get(t.id)!;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  for (const g of input.groups ?? []) {
    minX = Math.min(minX, g.x);
    minY = Math.min(minY, g.y);
    maxX = Math.max(maxX, g.x + g.w);
    maxY = Math.max(maxY, g.y + g.h);
  }
  if (!shown.length) throw new Error('The diagram is empty');
  const titleH = title ? 44 : 0;
  const width = Math.ceil(maxX - minX + PAD * 2);
  const height = Math.ceil(maxY - minY + PAD * 2 + titleH);
  const ox = PAD - minX;
  const oy = PAD + titleH - minY;
  const byId = new Map(shown.map((t) => [t.id, t]));
  const fkCols = new Set(relations.flatMap((r) => r.fromColumns));
  const rowY = (b: Box, t: Table, colId: string) => b.y + COL_TOP + t.columns.findIndex((c) => c.id === colId) * ROW_HEIGHT + ROW_HEIGHT / 2;

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${esc(FONT)}">`,
    `<defs>`,
    `<marker id="one" viewBox="0 0 20 20" refX="20" refY="10" markerWidth="20" markerHeight="20" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M10 4 L10 16 M0 10 L20 10" fill="none" stroke="${p.edge}" stroke-width="1.5"/></marker>`,
    `<marker id="many" viewBox="0 0 20 20" refX="20" refY="10" markerWidth="20" markerHeight="20" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 10 L20 10 M7 10 L20 3 M7 10 L20 17" fill="none" stroke="${p.edge}" stroke-width="1.5"/></marker>`,
    `</defs>`,
    `<rect width="100%" height="100%" fill="${p.bg}"/>`,
  );
  if (title) out.push(`<text x="${PAD}" y="${PAD - 4}" font-size="20" font-weight="600" fill="${p.fg}">${esc(title)}</text>`);
  out.push(`<g transform="translate(${ox} ${oy})">`);

  const obstacles: Rect[] = shown.map((t) => {
    const b = boxes.get(t.id)!;
    return { x1: b.x, y1: b.y, x2: b.x + b.w, y2: b.y + b.h };
  });

  // Groups behind everything, then edges, then tables.
  for (const g of input.groups ?? []) {
    out.push(
      `<g><rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="12" fill="${g.color}" fill-opacity="0.06" stroke="${g.color}" stroke-opacity="0.55" stroke-width="1.5"${g.depth ? ' stroke-dasharray="6 4"' : ''}/>`,
      `<text x="${g.x + 14}" y="${g.y + 21}" font-family="${esc(MONO)}" font-size="11" font-weight="700" letter-spacing="0.08em" fill="${g.color}">${esc(g.name.toUpperCase())}</text></g>`,
    );
  }

  // Edges first so tables sit on top.
  const chips: string[] = [];
  out.push(`<g fill="none" stroke="${p.edge}" stroke-width="1.4">`);
  for (const r of relations) {
    const parent = byId.get(r.toTable);
    const child = byId.get(r.fromTable);
    if (!parent || !child) continue;
    const pb = boxes.get(parent.id)!;
    const cb = boxes.get(child.id)!;
    const { s, t } = edgeSides(pb, cb, parent.id === child.id);
    void s;
    void t;
    const fk = r.fromColumns.map((id) => child.columns.find((c) => c.id === id));
    const childPk = child.columns.filter((c) => c.pk);
    const oneToOne =
      (fk.length === 1 && !!fk[0] && (fk[0].unique || (fk[0].pk && childPk.length === 1))) ||
      (fk.length > 1 && fk.length === childPk.length && fk.every((c) => c?.pk));
    r.fromColumns.forEach((fc, i) => {
      const tc = r.toColumns[i];
      const geo = edgeSidesFor(parent, pb, tc, child, cb, fc, parent.id === child.id);
      const sx = geo.source.x;
      const sy = geo.source.y;
      const tx = geo.target.x;
      const ty = geo.target.y;
      const route = input.routing === false ? null : routeOrthogonal(geo.source, geo.sSide, geo.target, geo.tSide, obstacles);
      const path = route
        ? roundedPath(route)
        : getSmoothStepPath({
            sourceX: sx,
            sourceY: sy,
            sourcePosition: geo.sSide === 'R' ? Side.Right : Side.Left,
            targetX: tx,
            targetY: ty,
            targetPosition: geo.tSide === 'R' ? Side.Right : Side.Left,
            borderRadius: 10,
            offset: 28,
          })[0];
      const s = geo.sSide;
      const t = geo.tSide;
      out.push(`<path d="${path}" marker-start="url(#one)" marker-end="url(#${oneToOne ? 'one' : 'many'})"/>`);
      const chip = (x: number, y: number, label: string, color: string) =>
        `<g><rect x="${x - 10}" y="${y - 21}" width="20" height="13" rx="3" fill="${p.bg}" stroke="${color}"/><text x="${x}" y="${y - 11.5}" font-family="${esc(MONO)}" font-size="9" font-weight="700" text-anchor="middle" fill="${color}">${label}</text></g>`;
      chips.push(chip(s === 'R' ? sx + 24 : sx - 24, sy, 'PK', p.pk), chip(t === 'R' ? tx + 24 : tx - 24, ty, 'FK', p.fk));
    });
  }
  out.push(`</g>`, ...chips);

  for (const t of shown) {
    const b = boxes.get(t.id)!;
    const clip = `c${t.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    out.push(
      `<g>`,
      `<clipPath id="${clip}"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6"/></clipPath>`,
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6" fill="${p.card}"/>`,
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${HEADER_HEIGHT}" fill="${p.header}" clip-path="url(#${clip})"/>`,
      `<line x1="${b.x}" y1="${b.y + HEADER_HEIGHT}" x2="${b.x + b.w}" y2="${b.y + HEADER_HEIGHT}" stroke="${p.border}"/>`,
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6" fill="none" stroke="${p.border}"/>`,
    );
    const schemaLabel = t.schema && !['public', 'dbo'].includes(t.schema) ? `${t.schema}.` : '';
    const name = fit(`${schemaLabel}${t.name}`, `600 13px ${FONT}`, b.w - 20);
    const nameRest = name.startsWith(schemaLabel) ? name.slice(schemaLabel.length) : name;
    out.push(
      `<text x="${b.x + 10}" y="${b.y + 24}" font-size="13">${schemaLabel && name.startsWith(schemaLabel) ? `<tspan fill="${p.muted}">${esc(schemaLabel)}</tspan>` : ''}<tspan font-weight="600" fill="${p.fg}">${esc(nameRest)}</tspan></text>`,
    );
    t.columns.forEach((c, i) => {
      const cy = b.y + COL_TOP + i * ROW_HEIGHT + ROW_HEIGHT / 2;
      const isFk = fkCols.has(c.id);
      if (c.pk) out.push(icon('key', b.x + 9, cy - 6.5, p.pk, 13));
      else if (isFk) out.push(icon('link', b.x + 9, cy - 6.5, p.fk, 13));
      else out.push(icon('diamond', b.x + 10, cy - 5.5, p.muted, 11, c.nullable ? 'none' : p.muted));
      const typeText = fit(c.type, `11px ${MONO}`, b.w * 0.45);
      const typeW = Math.min(b.w * 0.45, (measureCtx?.measureText(typeText).width ?? typeText.length * 6.6) + 8);
      const nameText = fit(c.name, `${c.pk ? '600 ' : ''}12px ${FONT}`, b.w - 40 - typeW);
      const flags = [c.identity ? '#' : '', c.unique && !c.pk ? 'U' : ''].filter(Boolean).join(' ');
      out.push(
        `<text x="${b.x + 28}" y="${cy + 4}" font-size="12"${c.pk ? ' font-weight="600"' : ''} fill="${p.fg}">${esc(nameText)}${flags ? `<tspan fill="${p.muted}" font-size="10" dx="5">${flags}</tspan>` : ''}</text>`,
        `<text x="${b.x + b.w - 10}" y="${cy + 4}" font-family="${esc(MONO)}" font-size="11" text-anchor="end" fill="${p.muted}">${esc(typeText)}</text>`,
      );
    });
    out.push(`</g>`);
  }
  out.push(`</g>`, `</svg>`);
  return { svg: out.join('\n'), width, height };
}

export interface RenderedImage {
  dataUrl: string;
  width: number;
  height: number;
  scale: number;
  bytes: number;
}

// Stay well inside browser canvas limits (Chromium: 32767 px per side, ~268M px area).
const MAX_SIDE = 16384;
const MAX_AREA = 120_000_000;

export async function renderDiagram(input: SvgInput, format: 'png' | 'svg'): Promise<RenderedImage> {
  const { svg, width, height } = buildSvg(input);
  if (format === 'svg') {
    const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    return { dataUrl, width, height, scale: 1, bytes: svg.length };
  }
  const fitScale = Math.min(MAX_SIDE / Math.max(width, height), Math.sqrt(MAX_AREA / (width * height)));
  const scale = Math.max(0.5, Math.min(4, Math.floor(fitScale * 100) / 100));
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas not available');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    return { dataUrl, width: canvas.width, height: canvas.height, scale, bytes: Math.round((dataUrl.length * 3) / 4) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Box for a table: measured size from the live diagram when known, else computed. */
export function boxFor(t: Table, pos: { x: number; y: number }, measured?: { width?: number; height?: number }): Box {
  return { x: pos.x, y: pos.y, w: measured?.width ?? NODE_WIDTH, h: measured?.height ?? nodeHeight(t) };
}
