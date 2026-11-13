import { defineConfig } from 'vitest/config';

/**
 * The whole suite with every limit of the posting workstream switched off (test/posting-off.setup.ts): what passed
 * before threads, comments, the mention audience and the open reply audience existed must pass here unchanged. The
 * tests of those pieces themselves (`test/posting-*.test.ts`) need them on and are left out, but for the one that
 * checks the switched-off state. Run: `pnpm --filter supervisor exec vitest run -c vitest.posting-off.config.ts`.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'test/posting-!(off).test.ts'],
    setupFiles: ['test/posting-off.setup.ts'],
    env: { SUPERVISOR_LOG_SILENT: '1', POSTING_OFF: '1' },
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
