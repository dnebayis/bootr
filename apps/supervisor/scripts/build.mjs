// Bundles the image's three entry points: src/index.ts into dist/index.js (the supervisor), src/db/migrate.ts into
// dist/db/migrate.js, and src/dataset/main.ts into dist/dataset.js (the dataset process, the `dataset` service of
// docker-compose.coolify.yml). Workspace packages that ship raw TypeScript (@bootr/shared, @bootr/inference/client)
// are inlined; everything from node_modules stays external.
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });

const inlineWorkspace = {
  name: 'inline-workspace',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('@bootr/')) return undefined;
      return { path: args.path, external: true };
    });
  },
};

for (const [entry, outfile] of [
  ['src/index.ts', 'dist/index.js'],
  ['src/db/migrate.ts', 'dist/db/migrate.js'],
  ['src/dataset/main.ts', 'dist/dataset.js'],
]) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    plugins: [inlineWorkspace],
    logLevel: 'info',
  });
}
