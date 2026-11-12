import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TOOL_LIST } from '@bootr/agent-core/tools';
import { DEVICE_CODE_TTL_S, DEVICE_POLL_INTERVAL_S, MCP_TOOL_PREFIX, OWN_ERRORS, PICTURE_MAX_BYTES, USER_CODE_ALPHABET } from '@bootr/shared/own-agent';
import { describe, expect, it } from 'vitest';
import * as fake from '../../../packages/mcp/test/fake-supervisor.mjs';

/**
 * `@bootrfun/sdk` is published on its own and cannot import the private `@bootr/shared`, so it carries a copy of the
 * own-agent wire types (docs/design/byo-agent.md section 13.3). The copy must be the same bytes: this fails when one
 * of the two files changes without the other, and the fix is to copy the shared file over the SDK's.
 */
const REPO = path.resolve(import.meta.dirname, '../../..');
const SHARED = path.join(REPO, 'packages/shared/src/own-agent.ts');
const SDK = path.join(REPO, 'packages/sdk/src/own-agent.ts');

describe('the SDK’s copy of the own-agent types', () => {
  it('is the shared file, byte for byte', () => {
    const shared = readFileSync(SHARED);
    const sdk = readFileSync(SDK);
    expect(sdk.equals(shared), 'copy packages/shared/src/own-agent.ts over packages/sdk/src/own-agent.ts').toBe(true);
  });

  it('says a client was disconnected without saying by whom, and what to do next', () => {
    // A client ends its own connection too (`bootr own disconnect`, `bootr_agent_disconnect`): the text holds for both.
    const { message } = OWN_ERRORS.credential_revoked;
    expect(message).toBe('This client was disconnected, from the client itself or in the creator console. Connect it to Bootr again to use it.');
    expect(readFileSync(SDK, 'utf8')).toContain(message);
  });

  it('imports nothing, so every package can take it', () => {
    expect(readFileSync(SHARED, 'utf8')).not.toMatch(/^\s*import\s/m);
  });

  it('is exported by the shared package under ./own-agent', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, 'packages/shared/package.json'), 'utf8')) as { exports: Record<string, string> };
    expect(pkg.exports['./own-agent']).toBe('./src/own-agent.ts');
  });
});

/**
 * The MCP server names the agent's tools itself (its descriptions are fixed text, nothing from the network), so its
 * list is a copy of agent-core's: this fails when a tool is added, renamed or changes from a read to a write there.
 */
describe('the MCP server’s list of agent tools', () => {
  const src = readFileSync(path.join(REPO, 'packages/mcp/src/agent-tools.ts'), 'utf8');
  const listed = [...src.matchAll(/\{ name: '(\w+)', title: '[^']+', annotations: (READ|SENDS|WRITE|ACTS),/g)].map((m) => ({ name: m[1]!, kind: m[2]! }));

  it('is agent-core’s catalog without generate_image and finish, in its order', () => {
    expect(listed).toHaveLength(23);
    expect(listed.map((t) => t.name)).toEqual(TOOL_LIST.map((t) => t.name).filter((n) => n !== 'generate_image' && n !== 'finish'));
    expect(MCP_TOOL_PREFIX).toBe('bootr_agent_');
  });

  it('marks as read-only the tools whose effect is a read, less the three whose input leaves for a third party, and as acting the five the contract names', () => {
    const effect = new Map<string, string>(TOOL_LIST.map((t) => [t.name, t.effect]));
    // A read is READ, or SENDS when what the model puts in goes out to the web, a search service or a directory.
    for (const t of listed) expect(t.kind === 'READ' || t.kind === 'SENDS', t.name).toBe(effect.get(t.name) === 'read');
    expect(listed.filter((t) => t.kind === 'SENDS').map((t) => t.name).sort()).toEqual(['discover_services', 'read_url', 'search_web']);
    expect(listed.filter((t) => t.kind === 'ACTS').map((t) => t.name).sort()).toEqual(['bounty_post', 'publish_post', 'publish_reply', 'treasury_execute', 'x402_fetch']);
    // Everything that moves money is among them.
    for (const t of TOOL_LIST.filter((x) => x.effect === 'money')) expect(listed.find((l) => l.name === t.name)?.kind, t.name).toBe('ACTS');
  });
});

describe('the fake supervisor of the packages’ tests', () => {
  it('holds the contract’s constants, error table and tool names', () => {
    expect(fake.OWN_ERRORS).toEqual(OWN_ERRORS);
    expect(fake.USER_CODE_ALPHABET).toBe(USER_CODE_ALPHABET);
    expect(fake.DEVICE_CODE_TTL_S).toBe(DEVICE_CODE_TTL_S);
    expect(fake.DEVICE_POLL_INTERVAL_S).toBe(DEVICE_POLL_INTERVAL_S);
    expect(fake.PICTURE_MAX_BYTES).toBe(PICTURE_MAX_BYTES);
    expect(fake.ACTION_TOOLS).toEqual(TOOL_LIST.map((t) => t.name).filter((n) => n !== 'generate_image' && n !== 'finish'));
  });
});
