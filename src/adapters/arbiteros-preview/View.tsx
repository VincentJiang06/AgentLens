/**
 * The preview's only view. Three things here are the point of the example:
 *
 *   - long lists go through `shell/VirtualList`. Virtualisation is opt-in — an
 *     adapter that maps over `model.cases` puts every row in the DOM;
 *   - a `?record=` that matches nothing is stated on screen, in the same words
 *     the raw record browser uses. A dead outreach link that looks fine is worse
 *     than one that errors;
 *   - every word this view writes goes through `useT`, and every word that came
 *     out of the case files — the trace id, the tool names, the suite's own
 *     safe/unsafe verdict — does not. An adapter is where that line is easiest
 *     to cross, so the worked example draws it explicitly.
 */

import { useMemo } from 'react'
import type { FC } from 'react'
import { useT } from '../../shell/lang'
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
  const t = useT()
  const selectedIndex = useMemo(() => caseIndexFor(model, recordId), [model, recordId])
  const missed = model.cases.length > 0 && recordId !== undefined && selectedIndex < 0
  const shown = model.cases.length.toLocaleString()
  const dropped = model.skipped.toLocaleString()

  return (
    <section className="cases">
      <header className="cases-head">
        <span>{t({ en: `${shown} cases`, zh: `${shown} 个用例` })}</span>
        {model.skipped > 0 && (
          <span>
            {t({
              en: `· ${dropped} records carried no trace id`,
              zh: `· ${dropped} 条记录没有 trace id`,
            })}
          </span>
        )}
        {missed && (
          <span className="badge warn">
            {/* Same wording as `shell/RecordBrowser`: one miss, one sentence. */}
            {t({ en: `no record “${recordId}” here`, zh: `这里没有记录「${recordId}」` })}
          </span>
        )}
      </header>

      <div className="cases-list">
        <VirtualList
          items={model.cases}
          estimateSize={ROW_HEIGHT}
          scrollToIndex={selectedIndex >= 0 ? selectedIndex : undefined}
          getKey={(one) => one.id}
          label={t({ en: 'ArbiterOS red-team cases', zh: 'ArbiterOS 红队用例' })}
          empty={
            <span className="muted">
              {t({
                en: 'No red-team cases in these files.',
                zh: '这些文件里没有红队用例。',
              })}
            </span>
          }
          renderRow={(one, index) => (
            <div className="list-row case-row" aria-current={index === selectedIndex || undefined}>
              <span className="list-index">{one.index}</span>
              <span className="case-trace truncate mono">{one.traceId}</span>
              <span className="case-action truncate">
                {/* `one.action` is the case's own tool names, so it is interpolated
                    verbatim into both languages rather than translated. */}
                {t({
                  en: `${one.priorSteps} prior → ${one.action}`,
                  zh: `前 ${one.priorSteps} 步 → ${one.action}`,
                })}
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
