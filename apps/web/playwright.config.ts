import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3210);

/** Values used by the smoke tests. Not secrets: test-only. */
export const E2E_ENV = {
  NEXT_PUBLIC_USE_MOCK: '1',
  NEXT_PUBLIC_CHAIN_ID: '84532',
  ADMIN_CONSOLE_SLUG: 'e2e-console-slug',
  SESSION_SECRET: 'e2e-session-secret-not-for-production',
  ADMIN_ADDRESSES: '0x000000000000000000000000000000000000e2e1',
};

for (const [k, v] of Object.entries(E2E_ENV)) process.env[k] ??= v;

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    // The token cards drift forever (TokenCard `animate-float`), which Playwright reads as an element that never
    // settles, so a click waits until it times out; the drift is off under reduced motion.
    contextOptions: { reducedMotion: 'reduce' },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Production build so the proxy, prerendering and Cache Components behave as deployed.
    command: `pnpm exec next build && pnpm exec next start -p ${PORT}`,
    url: `http://localhost:${PORT}/robots.txt`,
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    env: { ...E2E_ENV },
  },
});
