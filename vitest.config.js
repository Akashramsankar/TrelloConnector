import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    hmr: false
  },
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/unit',
      reporter: ['json', 'text'],
      include: [
        'server/app_metadata.js',
        'server/installation_capture.js'
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80
      }
    }
  }
});
