import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['**/*.js'],
      exclude: ['test/**', 'node_modules/**', 'generate-ssl.js', 'inspect_db.cjs', 'test-route.js'],
      all: true,
      thresholds: {
        statements: 89.87,
        branches: 77.04,
        functions: 90.02,
        lines: 93.04,
      }
    },
    environment: 'node',
    env: {
      UI_DATABASE_PATH: './test-persistence.db',
    },
  },
});
