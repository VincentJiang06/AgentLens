import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { register } from './adapters/registry'
import { arbiterosPreviewAdapter } from './adapters/arbiteros-preview'
import { ErrorBoundary } from './shell/ErrorBoundary'
import { initTheme } from './shell/theme'

/**
 * Mount point. Adapters are registered here, before the first render, so the
 * landing page can ask the registry what exists. M1..M4 each add one line —
 * this file, not `adapters/registry.ts`, is where registration happens.
 */

initTheme()
register(arbiterosPreviewAdapter, { formatVersions: ['1'] })

const container = document.getElementById('root')
if (!container) throw new Error('index.html is missing #root')

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary
      fallback={(error, reset) => (
        <div className="container stack">
          <h1>AgentLens stopped</h1>
          <p className="notice bad">{error.message}</p>
          <p className="muted">
            Nothing was uploaded — the failure is local to this tab. Reload, or try again with the
            file that caused it.
          </p>
          <span className="cluster">
            <button type="button" className="primary" onClick={reset}>
              Try again
            </button>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </span>
        </div>
      )}
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
