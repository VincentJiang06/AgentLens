import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * GitHub Pages serves project sites from https://<user>.github.io/<repo>/.
 * A fork under a different repo name must change this to match, or every
 * asset 404s.
 */
const PAGES_BASE = '/agentlens/'

export default defineConfig(({ command, isPreview }) => ({
  // `vite preview` serves the built output, so it needs the production base too.
  base: command === 'serve' && !isPreview ? '/' : PAGES_BASE,
  plugins: [react()],
  // parse.worker.ts is a module worker; the default 'iife' output drops its imports.
  worker: { format: 'es' },
}))
