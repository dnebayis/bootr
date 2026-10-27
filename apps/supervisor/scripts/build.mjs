// Bundles src/index.ts into dist/index.js. Workspace packages that ship raw TypeScript
// (@bootr/shared, @bootr/inference/client) are inlined; everything from node_modules stays external.
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

for (const entry of ['src/index.ts', 'src/db/migrate.ts']) {
  await build({
    entryPoints: [entry],
    outdir: entry === 'src/index.ts' ? 'dist' : 'dist/db',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    plugins: [inlineWorkspace],
    logLevel: 'info',
  });
}
