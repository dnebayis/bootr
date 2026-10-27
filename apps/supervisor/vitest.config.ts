import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: { SUPERVISOR_LOG_SILENT: '1' },
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
