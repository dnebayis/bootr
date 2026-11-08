import path from 'node:path';
import { defineConfig } from 'vitest/config';

/** Unit tests for lib/ (server helpers, pure builders). Browser flows are covered by `pnpm test:e2e` (Playwright). */
export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname) } },
  test: {
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts', 'components/ui/**/*.test.{ts,tsx}', 'components/shell/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
