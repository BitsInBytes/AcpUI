/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// https://vite.dev/config/
export default defineConfig({
  envDir: '../',
  envPrefix: ['VITE_', 'BACKEND_PORT', 'FRONTEND_PORT', 'HEALTH_DASHBOARD_PORT', 'HOST', 'FLAGSHIP_MODEL', 'BALANCED_MODEL'],
  plugins: [
    react(),
    basicSsl()
  ],
  server: {
    https: true,
    host: true
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    pool: 'forks',
    maxWorkers: 2,
    testTimeout: 30000,
    hookTimeout: 60000,
    coverage: {
      provider: 'v8',
      thresholds: {
        statements: 78.56,
        branches: 69.53,
        functions: 77.54,
        lines: 82.44
      }
    }
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any) // Using 'as any' to bypass the 'test' property error in Vite's UserConfig
