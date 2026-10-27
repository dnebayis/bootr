import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: { SENDER_LOG_SILENT: '1' },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
