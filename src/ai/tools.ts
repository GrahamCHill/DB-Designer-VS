// Language Model Tools so chat agents in VS Code (e.g. Copilot agent mode) can read the open
// diagram and propose schema changes. Changes need the user's confirmation and land as an undoable draft.

import * as vscode from 'vscode';
import { ErdPanel } from '../erdPanel';
import { Schema, qualifiedName } from '../shared/model';
import { describeOp, sanitizeOps } from '../shared/ops';
import { generateFullSql } from '../shared/pgExport';

const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

function noDiagram() {
  return text('No ERD Viewer diagram is open. Ask the user to open one first (command "ERD Viewer: Open ERD from SQL Folder…" or "…from Database Connection…").');
}

function compactJson(s: Schema): string {
  const byId = new Map(s.tables.map((t) => [t.id, t]));
  const colName = (tid: string, cid: string) => byId.get(tid)?.columns.find((c) => c.id === cid)?.name ?? '?';
  return JSON.stringify({
    dialect: s.dialect,
    tables: s.tables.map((t) => ({
      name: qualifiedName(t),
      comment: t.comment,
      columns: t.columns.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable && !c.pk,
        pk: c.pk || undefined,
        unique: c.unique || undefined,
        default: c.default,
      })),
    })),
    foreign_keys: s.relations.map((r) => ({
      table: qualifiedName(byId.get(r.fromTable)!),
      columns: r.fromColumns.map((id) => colName(r.fromTable, id)),
      ref_table: qualifiedName(byId.get(r.toTable)!),
      ref_columns: r.toColumns.map((id) => colName(r.toTable, id)),
      on_delete: r.onDelete,
    })),
  });
}

export function registerTools(context: vscode.ExtensionContext) {
  if (!vscode.lm?.registerTool) return; // older VS Code

  context.subscriptions.push(
    vscode.lm.registerTool<{ format?: 'ddl' | 'json' }>('erd-viewer_getSchema', {
      async invoke(options) {
        const panel = ErdPanel.active();
        const schema = panel?.currentSchema();
        if (!panel || !schema) return noDiagram();
        const header = `ERD diagram "${panel.title}": ${schema.tables.length} tables, ${schema.relations.length} foreign keys (source dialect: ${schema.dialect}). This is the current state including unsaved diagram edits.`;
        const body = options.input?.format === 'json' ? compactJson(schema) : generateFullSql(schema);
        return text(`${header}\n\n${body}`);
      },
      prepareInvocation() {
        const panel = ErdPanel.active();
        return { invocationMessage: panel ? `Reading ERD diagram "${panel.title}"` : 'Reading ERD diagram' };
      },
    }),

    vscode.lm.registerTool<{ operations: unknown[]; description?: string }>('erd-viewer_applyChanges', {
      prepareInvocation(options) {
        const { ops, problems } = sanitizeOps(options.input?.operations);
        const panel = ErdPanel.active();
        const lines = ops.map((o) => `- ${describeOp(o)}`);
        if (problems.length) lines.push('', `Ignored (invalid): ${problems.join('; ')}`);
        return {
          invocationMessage: `Applying ${ops.length} change(s) to the ERD diagram`,
          confirmationMessages: {
            title: `Apply ${ops.length} change(s) to "${panel?.title ?? 'ERD diagram'}"?`,
            message: new vscode.MarkdownString(
              `${options.input?.description ? `${options.input.description}\n\n` : ''}${lines.join('\n')}\n\n` +
                'Changes are applied to the diagram as a draft. You can undo them (Ctrl+Z) or export them as a migration.',
            ),
          },
        };
      },
      async invoke(options) {
        const panel = ErdPanel.active();
        if (!panel) return noDiagram();
        const { ops, problems } = sanitizeOps(options.input?.operations);
        if (!ops.length) return text(`No valid operations to apply.${problems.length ? ` Problems: ${problems.join('; ')}` : ''}`);
        panel.reveal();
        const errors = await panel.applyOps(ops, options.input?.description);
        const applied = ops.length - errors.length;
        const parts = [`Applied ${applied} of ${ops.length} operation(s) to the diagram "${panel.title}" as an unsaved draft.`];
        if (errors.length) parts.push(`Failed: ${errors.join('; ')}`);
        if (problems.length) parts.push(`Ignored invalid operations: ${problems.join('; ')}`);
        parts.push('The user can review the change in the diagram, undo it, or export it with "Export SQL → Changes only (migration)".');
        return text(parts.join('\n'));
      },
    }),
  );
}
