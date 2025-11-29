import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import path from 'node:path'

// Polyfill for Node.js modules
const nodePolyfills = (): Plugin => ({
  name: 'node-polyfills',
  config() {
    return {
      define: {
        'process.env': {},
        global: 'globalThis',
      },
    }
  },
})

export default defineConfig({
  plugins: [
    nodePolyfills(),
    TanStackRouterVite(),
    react(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'path': 'path-browserify',
      'process': 'process/browser',
      'url': 'url',
    },
  },
  server: {
    port: 3000,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
  optimizeDeps: {
    include: ['shiki', 'streamdown', 'style-to-js'],
    exclude: [],
  },
})
