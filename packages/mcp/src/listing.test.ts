import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `server.json` is what the official MCP registry (registry.modelcontextprotocol.io) lists this server from. The
 * registry checks it against the npm package: it reads the published version named there and refuses the listing
 * unless that version's `mcpName` is the listing's name. So the three places a release is written (package.json,
 * `VERSION` in index.ts, server.json) and the two places the name is written have to agree, or the publish fails
 * after the npm version is already out. docs/dev/mcp-listings.md has the owner's steps.
 */

const root = path.resolve(import.meta.dirname, '..');
const json = (file: string) => JSON.parse(readFileSync(path.resolve(root, file), 'utf8'));
const pkg = json('package.json');
const server = json('server.json');
const npm = server.packages[0];

/** Every `BOOTR_*` name the shipped source of a folder mentions, tests left out. */
function settingsRead(dir: string): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(path.resolve(root, dir))) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    for (const m of readFileSync(path.resolve(root, dir, file), 'utf8').matchAll(/\bBOOTR_[A-Z_]+\b/g)) names.add(m[0]);
  }
  return [...names];
}

describe('the registry listing', () => {
  it('carries the version of the package, in all three places', () => {
    expect(server.version).toBe(pkg.version);
    expect(npm.version).toBe(pkg.version);
    expect(readFileSync(path.resolve(root, 'src/index.ts'), 'utf8')).toContain(`const VERSION = '${pkg.version}';`);
  });

  it('is released together with the SDK and the CLI, at one version', () => {
    expect(json('../sdk/package.json').version).toBe(pkg.version);
    expect(json('../cli/package.json').version).toBe(pkg.version);
  });

  it('names the server as the npm package does, which is how the registry checks who owns it', () => {
    expect(pkg.mcpName).toBe(server.name);
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(npm).toMatchObject({ registryType: 'npm', identifier: pkg.name, transport: { type: 'stdio' } });
  });

  it('keeps the description inside the registry limit of 100 characters', () => {
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.title.length).toBeLessThanOrEqual(100);
  });

  it('lists exactly the settings the server reads, none required and none secret', () => {
    const listed = npm.environmentVariables as { name: string; isRequired?: boolean; isSecret?: boolean; description?: string }[];
    const read = new Set([...settingsRead('src'), ...settingsRead('../sdk/src')]);
    expect(listed.map((v) => v.name).sort()).toEqual([...read].sort());
    for (const v of listed) {
      expect(v.isRequired).toBe(false);
      expect(v.isSecret).toBe(false);
      expect(v.description).toBeTruthy();
    }
  });

  it('stays out of the npm package: the registry takes it from the repository, not from the tarball', () => {
    expect(pkg.files).toEqual(['dist', 'README.md', 'LICENSE']);
  });
});
