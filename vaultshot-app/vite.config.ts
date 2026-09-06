import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig, type Plugin } from 'vite'

const isDev = process.env.NODE_ENV !== 'production'

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(isDev ? [basicSsl() as Plugin] : [])],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    exclude: ['@zama-fhe/relayer-sdk'],
  },
  resolve: {
    conditions: ['browser', 'module', 'import'],
  },
})
