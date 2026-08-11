import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * GitHub Pages serves project sites from https://<user>.github.io/<repo>/, and
 * those paths are CASE-SENSITIVE: a repo named `AgentLens` is not reachable at
 * `/agentlens/`. A hardcoded base is therefore a footgun that fails in the one
 * place nobody looks — the deployed site returns 200 for the page and 404s every
 * asset, so it looks live and is blank.
 *
 * Actions always sets GITHUB_REPOSITORY to `owner/repo`, so the deploy derives
 * its own base and a fork under any name is correct without an edit. The literal
 * is only the local fallback, for `vite preview`.
 */
const PAGES_BASE = `/${process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'AgentLens'}/`

export default defineConfig(({ command, isPreview }) => ({
  // `vite preview` serves the built output, so it needs the production base too.
  base: command === 'serve' && !isPreview ? '/' : PAGES_BASE,
  plugins: [react()],
  // parse.worker.ts is a module worker; the default 'iife' output drops its imports.
  worker: { format: 'es' },
}))
