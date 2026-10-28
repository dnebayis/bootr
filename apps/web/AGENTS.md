<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Docs and /llms.txt

- `/docs`, `/llms.txt` and `/llms-full.txt` are generated from one source: `components/docs/content.ts` (blocks) and
  `components/docs/pages.ts` (page list). Edit those, never the routes; `lib/docs/markdown.ts` does the Markdown.
- Every statement there describes code elsewhere (contracts, indexer, agent-core, supervisor, sender). Check the code
  before changing a sentence, and change the sentence when you change that code. The tool list mirrors
  `packages/agent-core/src/tools.ts` and the GraphQL examples `apps/indexer/ponder.schema.ts`; tests fail on drift.
- Public docs never mention HMAC-protected `/internal/*` routes, the supervisor's admin API, the admin console or
  `/api/admin/*`. `lib/docs/markdown.test.ts` checks for the obvious strings.
- Docs pages are static routes (`app/docs/<slug>/page.tsx`): do not read `params` there (Cache Components +
  instant navigation).
