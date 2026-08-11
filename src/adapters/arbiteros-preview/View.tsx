/**
 * The preview's only view. Two things here are the point of the example:
 *
 *   - long lists go through `shell/VirtualList`. Virtualisation is opt-in — an
 *     adapter that maps over `model.cases` puts every row in the DOM;
 *   - a `?record=` that matches nothing is stated on screen, in the same words
 *     the raw record browser uses. A dead outreach link that looks fine is worse
 *     than one that errors.
 */

import { useMemo } from 'react'
import type { FC } from 'react'
import { VirtualList } from '../../shell/VirtualList'
import { caseIndexFor } from './model'
import type { ArbiterosPreviewModel } from './model'
import './view.css'

/** Matches `--row-h`; only affects scrollbar accuracy until rows are measured. */
const ROW_HEIGHT = 28

export const View: FC<{ model: ArbiterosPreviewModel; recordId?: string }> = ({
  model,
  recordId,
}) => {
  const selectedIndex = useMemo(() => caseIndexFor(model, recordId), [model, recordId])
  const missed = model.cases.length > 0 && recordId !== undefined && selectedIndex < 0

  return (
    <section className="cases">
      <header className="cases-head">
        <span>{model.cases.length.toLocaleString()} cases</span>
        {model.skipped > 0 && (
          <span>· {model.skipped.toLocaleString()} records carried no trace id</span>
        )}
        {missed && <span className="badge warn">no record “{recordId}” here</span>}
      </header>

      <div className="cases-list">
        <VirtualList
          items={model.cases}
          estimateSize={ROW_HEIGHT}
          scrollToIndex={selectedIndex >= 0 ? selectedIndex : undefined}
          getKey={(one) => one.id}
          label="ArbiterOS red-team cases"
          empty={<span className="muted">No red-team cases in these files.</span>}
          renderRow={(one, index) => (
            <div className="list-row case-row" aria-current={index === selectedIndex || undefined}>
              <span className="list-index">{one.index}</span>
              <span className="case-trace truncate mono">{one.traceId}</span>
              <span className="case-action truncate">
                {one.priorSteps} prior → {one.action}
              </span>
              {one.verdict && (
                <span className={`badge ${one.verdict === 'unsafe' ? 'bad' : 'ok'}`}>
                  {one.verdict}
                </span>
              )}
            </div>
          )}
        />
      </div>
    </section>
  )
}
