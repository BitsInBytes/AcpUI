import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js', '../providers/*/test/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['**/*.js', '../providers/**/*.js'],
      exclude: ['test/**', 'node_modules/**', 'generate-ssl.js', 'inspect_db.cjs', 'test-route.js', '../providers/**/test/**'],
      all: true,
      thresholds: {
        statements: 89.2,
        branches: 78.5,
        functions: 93.25,
        lines: 91.85,
      }
    },
    environment: 'node',
    env: {
      UI_DATABASE_PATH: './test-persistence.db',
    },
  },
});

