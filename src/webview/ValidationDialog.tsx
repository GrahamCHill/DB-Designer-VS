import React from 'react';
import type { Verification } from '../verify/index';
import { EXPORT_DIALECTS } from '../shared/sqlExport';
import { CloseIcon } from './icons';

interface Props {
  results: Verification[] | 'running';
  onClose(): void;
}

export function ValidationDialog({ results, onClose }: Props) {
  return (
    <div className="erd-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="erd-modal" role="dialog" aria-label="SQL validation" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header>
          <h2>SQL validation</h2>
          <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="erd-modal-body">
          {results === 'running' ? (
            <div className="ai-run">
              <span className="spinner" aria-hidden /> Generating and checking SQL for every dialect…
            </div>
          ) : (
            results.map((r) => {
              const label = EXPORT_DIALECTS.find((d) => d.id === r.dialect)?.label ?? r.dialect;
              return (
                <div key={r.dialect} className={`val-row ${r.ok ? 'ok' : 'bad'}`}>
                  <div className="val-head">
                    <span className="val-mark">{r.ok ? '✓' : '✗'}</span>
                    <strong>{label}</strong>
                    <span className="muted small grow">{r.summary}</span>
                  </div>
                  {r.errors.length ? (
                    <ul className="problems">
                      {r.errors.slice(0, 8).map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                      {r.errors.length > 8 ? <li>…and {r.errors.length - 8} more (see the DB Designer output)</li> : null}
                    </ul>
                  ) : null}
                  {r.warnings.length ? (
                    <details className="small">
                      <summary className="muted">{r.warnings.length} note{r.warnings.length === 1 ? '' : 's'}</summary>
                      <ul className="val-notes">
                        {r.warnings.slice(0, 30).map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
        <footer>
          <span className="muted small grow">Every export is validated like this before it is saved.</span>
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
