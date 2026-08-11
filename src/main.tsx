import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { register } from './adapters/registry'
import { arbiterosAdapter } from './adapters/arbiteros'
import { arbiterosPreviewAdapter } from './adapters/arbiteros-preview'
import { promptWiseAdapter } from './adapters/promptwise'
import { rmR1Adapter } from './adapters/rm-r1'
import { ErrorBoundary } from './shell/ErrorBoundary'
import { initLang, translate } from './shell/lang'
import { initTheme } from './shell/theme'

/**
 * Mount point. Adapters are registered here, before the first render, so the
 * landing page can ask the registry what exists. M1..M4 each add one line —
 * this file, not `adapters/registry.ts`, is where registration happens.
 */

initTheme()
initLang()
register(rmR1Adapter, { formatVersions: ['1'] })
register(promptWiseAdapter, { formatVersions: ['1'] })
// `formatNames`, because the package `scripts/arbiteros-runner/run.py` writes
// declares `arbiteros-trace@1` while the adapter is registered as `arbiteros` —
// the name the landing page matches against the M3 roadmap row. Without the
// alias, dispatch reports the demo package as handled by no adapter and falls
// through to fingerprinting: it still opens, at confidence 1, but under a
// warning that says the opposite of what happened. The alias states which tags
// this adapter reads; it renames nothing, so the runner and its tests stand.
register(arbiterosAdapter, { formatVersions: ['1'], formatNames: ['arbiteros-trace'] })
// Registered after `arbiteros`, so the replay's card comes first and the raw
// case files sit beside it. It is not superseded: the two cards open two
// different artifacts, and `App.tsx` says which is which on the second one.
register(arbiterosPreviewAdapter, { formatVersions: ['1'] })

const container = document.getElementById('root')
if (!container) throw new Error('index.html is missing #root')

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary
      /**
       * The last screen standing: it renders when `App` itself failed, so it can
       * hold no hook — the boundary is a class component and this is its render.
       * `translate()` reads the same resolved language `useT` would, which is why
       * the one screen shown after everything else broke is not the one screen
       * that reverts to English. `error.message` is the platform's own words and
       * is shown as it arrived, like every other quoted string in this app.
       */
      fallback={(error, reset) => (
        <div className="container stack">
          <h1>{translate({ en: 'AgentLens stopped', zh: 'AgentLens 已停止' })}</h1>
          <p className="notice bad">{error.message}</p>
          <p className="muted">
            {translate({
              en: 'Nothing was uploaded — the failure is local to this tab. Reload, or try again with the file that caused it.',
              zh: '没有任何数据被上传——这次失败只发生在这个标签页里。重新载入，或者用出问题的那个文件再试一次。',
            })}
          </p>
          <span className="cluster">
            <button type="button" className="primary" onClick={reset}>
              {translate({ en: 'Try again', zh: '重试' })}
            </button>
            <button type="button" onClick={() => window.location.reload()}>
              {translate({ en: 'Reload', zh: '重新载入' })}
            </button>
          </span>
        </div>
      )}
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
