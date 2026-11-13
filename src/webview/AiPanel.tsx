import React, { useState } from 'react';
import { AiReview, AiSuggestion } from '../shared/ai';
import { describeOp } from '../shared/ops';
import { CloseIcon } from './icons';

export interface AiState {
  loading: boolean;
  review?: AiReview;
  error?: string;
  /** suggestion id -> errors from applying it ([] = applied cleanly) */
  applied: Record<string, string[]>;
}

interface Props {
  state: AiState;
  provider: string;
  selectedTableName?: string;
  visibleCount: number;
  onRun(opts: { focus: string; selectedOnly: boolean }): void;
  onCancel(): void;
  onApply(s: AiSuggestion): void;
  onShowTables(names: string[]): void;
  onChooseProvider(): void;
  onExportMigration(): void;
  onClose(): void;
}

const SEV_ORDER = { high: 0, medium: 1, low: 2 } as const;

export function AiPanel(p: Props) {
  const [focus, setFocus] = useState('');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const { state } = p;
  const suggestions = [...(state.review?.suggestions ?? [])].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const pending = suggestions.filter((s) => !state.applied[s.id] && s.operations.length);
  const anyApplied = Object.keys(state.applied).length > 0;

  return (
    <aside className="erd-editor erd-ai" onKeyDown={(e) => e.key === 'Escape' && p.onClose()}>
      <header>
        <h2>✨ AI normalisation review</h2>
        <button className="icon-btn" title="Close (Esc)" onClick={p.onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="erd-editor-body">
        <div className="ai-provider">
          <span className="muted small">Model provider</span>
          <span className="grow">{p.provider || '…'}</span>
          <button className="btn" onClick={p.onChooseProvider}>
            Change
          </button>
        </div>
        <label className="field">
          <span>What should it focus on? (optional)</span>
          <textarea
            rows={3}
            value={focus}
            placeholder="e.g. the contracts and approvals tables; repeated address fields; whether lookups should be tables"
            onChange={(e) => setFocus(e.target.value)}
          />
        </label>
        <div className="checks">
          <label>
            <input type="radio" checked={!selectedOnly} onChange={() => setSelectedOnly(false)} /> Visible diagram ({p.visibleCount} tables)
          </label>
          <label title={p.selectedTableName ? '' : 'Select a table in the diagram first'}>
            <input type="radio" disabled={!p.selectedTableName} checked={selectedOnly} onChange={() => setSelectedOnly(true)} />{' '}
            {p.selectedTableName ? `${p.selectedTableName} + related` : 'Selected table + related'}
          </label>
        </div>
        <div className="ai-run">
          {state.loading ? (
            <>
              <span className="spinner" aria-hidden /> <span className="grow">Reviewing… this can take a minute for large schemas.</span>
              <button className="btn" onClick={p.onCancel}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn primary" onClick={() => p.onRun({ focus, selectedOnly: selectedOnly && !!p.selectedTableName })}>
              {state.review ? 'Run again' : 'Review schema'}
            </button>
          )}
        </div>
        <p className="muted small">
          Only the schema structure (tables, columns, types, keys) is sent to the model, never row data. Suggestions are applied to the diagram as an
          undoable draft, so nothing touches your database until you export and run a migration.
        </p>

        {state.error ? <div className="ai-error">{state.error}</div> : null}

        {state.review ? (
          <div className="ai-results">
            {state.review.summary ? <p className="ai-summary">{state.review.summary}</p> : null}
            <div className="ai-results-head">
              <span className="muted small grow">
                {suggestions.length} suggestion{suggestions.length === 1 ? '' : 's'}
                {state.review.model ? ` · ${state.review.model}` : ''}
              </span>
              {pending.length > 1 ? (
                <button className="btn" onClick={() => pending.forEach((s) => p.onApply(s))}>
                  Apply all ({pending.length})
                </button>
              ) : null}
              {anyApplied ? (
                <button className="btn primary" onClick={p.onExportMigration}>
                  Export migration
                </button>
              ) : null}
            </div>
            {suggestions.map((s) => {
              const applied = state.applied[s.id];
              return (
                <div key={s.id} className={`ai-card sev-${s.severity} ${applied ? 'done' : ''}`}>
                  <div className="ai-card-head">
                    <span className={`sev sev-${s.severity}`}>{s.severity}</span>
                    <span className="chip">{s.category}</span>
                    <strong className="grow">{s.title}</strong>
                  </div>
                  {s.tables.length ? (
                    <button className="link small" onClick={() => p.onShowTables(s.tables)} title="Show these tables in the diagram">
                      {s.tables.join(', ')}
                    </button>
                  ) : null}
                  <p>{s.explanation}</p>
                  {s.operations.length ? (
                    <ol className="ai-ops">
                      {s.operations.map((o, i) => (
                        <li key={i} className="mono">
                          {describeOp(o)}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="muted small">No automatic change. This one is advice only.</p>
                  )}
                  {s.problems?.length ? <p className="muted small">Skipped invalid steps: {s.problems.join('; ')}</p> : null}
                  {applied?.length ? <div className="ai-error small">Some steps failed: {applied.join('; ')}</div> : null}
                  {s.operations.length ? (
                    <div className="ai-card-actions">
                      {applied ? (
                        <span className="applied">✓ Applied{applied.length ? ' (partly)' : ''}. Press Ctrl+Z to undo</span>
                      ) : (
                        <button className="btn primary" onClick={() => p.onApply(s)}>
                          Apply to diagram
                        </button>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
