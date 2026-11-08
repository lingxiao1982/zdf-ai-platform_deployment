import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** Vite `base` needs a trailing slash. Empty / "/" → root. */
function publicBase() {
  const raw = process.env.BASE_PATH || process.env.VITE_BASE_PATH || ''
  if (!raw || raw === '/') return '/'
  const s = raw.startsWith('/') ? raw : `/${raw}`
  return s.endsWith('/') ? s : `${s}/`
}

const base = publicBase()
const prefix = base === '/' ? '' : base.replace(/\/$/, '')
const apiProxyPath = `${prefix}/api`

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    port: 8080,
    proxy: {
      [apiProxyPath]: {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  preview: {
    port: 8080,
    proxy: {
      [apiProxyPath]: {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  build: { outDir: 'dist', sourcemap: false }
})
