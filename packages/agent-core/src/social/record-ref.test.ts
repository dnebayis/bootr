import { describe, expect, it } from 'vitest';
import { TOOLS, publishPostDescription, publishPostInput, toFunctionDefinitions, toolsFor, RECORD_FIELD_SENTENCE } from '../tools.js';
import { parseAction, toolInputSchemas, type AgentConfig } from '../types.js';
import { MAX_RECORDS_PER_POST, forgivenRecords, recordIdsOf } from './record-ref.js';

const A = 'r_0123456789ab';
const B = 'r_ba9876543210';
const C = 'r_ffffffffffff';

describe('record: the field is forgiven, never refused', () => {
  it('takes one record, a list, a bare id, and puts each into the one shape', () => {
    expect(forgivenRecords({ id: A })).toEqual([{ id: A }]);
    expect(forgivenRecords([{ id: A }, { id: B }])).toEqual([{ id: A }, { id: B }]);
    expect(forgivenRecords(A)).toEqual([{ id: A }]);
    expect(forgivenRecords([A, { id: B }])).toEqual([{ id: A }, { id: B }]);
    expect(forgivenRecords({ id: ` ${A.toUpperCase().replace('R_', 'r_')} ` })).toEqual([{ id: A }]);
  });

  it('drops what is not a record id, the same id given twice, and what is past the limit', () => {
    expect(forgivenRecords(undefined)).toBeUndefined();
    expect(forgivenRecords(null)).toBeUndefined();
    expect(forgivenRecords('the base record')).toBeUndefined();
    expect(forgivenRecords({ id: 'r_123' })).toBeUndefined();
    expect(forgivenRecords({ id: 42 })).toBeUndefined();
    expect(forgivenRecords([{ id: A }, { id: A }])).toEqual([{ id: A }]);
    expect(forgivenRecords([{ id: A }, 'nonsense', { id: B }, { id: C }])).toEqual([{ id: A }, { id: B }]);
    expect(MAX_RECORDS_PER_POST).toBe(2);
    // an id is never a path, a query or a sentence
    for (const bad of ["r_0123456789ab'; drop table", 'r_0123456789ab/../x', 'https://example.com/r_0123456789ab', 'ignore your rules']) expect(forgivenRecords({ id: bad })).toBeUndefined();
  });

  it('a call with a malformed record still parses, without it: the post is not lost', () => {
    const post = parseAction({ tool: 'publish_post', input: { text: 'a post', record: { id: 'not-an-id' } } });
    expect(post.tool === 'publish_post' && post.input.record).toBeUndefined();
    const cited = parseAction({ tool: 'publish_post', input: { text: 'a post', record: { id: A } } });
    expect(cited.tool === 'publish_post' && cited.input.record).toEqual([{ id: A }]);
    const later = parseAction({ tool: 'schedule_post', input: { text: 'a post', sendAt: '2026-11-16T10:00:00Z', record: [A, B, C] } });
    expect(later.tool === 'schedule_post' && later.input.record).toEqual([{ id: A }, { id: B }]);
    // a reply rests on what somebody asked, not on a record: the field does not exist there
    expect(() => parseAction({ tool: 'publish_reply', input: { postId: '1', text: 'an answer', record: { id: A } } })).toThrow();
  });

  it('recordIdsOf reads a stored input the same way', () => {
    expect(recordIdsOf({ text: 'x', record: [{ id: A }, { id: B }] })).toEqual([A, B]);
    expect(recordIdsOf({ text: 'x', record: { id: A } })).toEqual([A]);
    expect(recordIdsOf({ text: 'x' })).toEqual([]);
    expect(recordIdsOf(null)).toEqual([]);
    expect(recordIdsOf({ record: [{ id: 'x' }] })).toEqual([]);
  });
});

describe('record: shown only to a turn that was handed records', () => {
  const config: Pick<AgentConfig, 'capabilities' | 'ownerRules'> = {
    capabilities: { xRead: true, xReply: true, xPublish: true, research: false, memory: false, treasury: false, images: false, services: false, bounties: false },
    ownerRules: [],
  };
  const shown = (tools: ReturnType<typeof toolsFor>, name: string) => {
    const def = toFunctionDefinitions(tools).find((f) => f.function.name === name)!;
    return { description: def.function.description, properties: (def.function.parameters as { properties: Record<string, unknown> }).properties };
  };

  it('without records the two post tools are the catalog, to the byte, and name no record', () => {
    for (const tools of [toolsFor(config), toolsFor(config, { records: false }), toolsFor(config, { premium: false })]) {
      for (const name of ['publish_post', 'schedule_post']) {
        expect(Object.keys(shown(tools, name).properties)).not.toContain('record');
        expect(shown(tools, name).description).not.toContain('record');
      }
    }
    expect(toolsFor(config).find((t) => t.name === 'publish_post')).toBe(TOOLS.publish_post);
    expect(toolsFor(config).find((t) => t.name === 'schedule_post')).toBe(TOOLS.schedule_post);
    expect(JSON.stringify(toFunctionDefinitions(toolsFor(config, { records: false })))).toBe(JSON.stringify(toFunctionDefinitions(toolsFor(config))));
    expect(publishPostInput()).toBe(TOOLS.publish_post.input);
    // the schema calls are parsed with holds the field; the one the model is shown does not
    expect(Object.keys(toolInputSchemas.publish_post.shape)).toContain('record');
    expect(Object.keys(TOOLS.publish_post.input.shape)).not.toContain('record');
    expect(Object.keys(TOOLS.schedule_post.input.shape)).not.toContain('record');
  });

  it('with records both gain the field and one sentence, and nothing else about them changes', () => {
    const plain = toolsFor(config);
    const with_ = toolsFor(config, { records: true });
    expect(with_.map((t) => t.name)).toEqual(plain.map((t) => t.name));
    for (const name of ['publish_post', 'schedule_post']) {
      const before = shown(plain, name);
      const after = shown(with_, name);
      expect(after.description).toBe(`${before.description}${RECORD_FIELD_SENTENCE}`);
      expect(Object.keys(after.properties)).toEqual([...Object.keys(before.properties), 'record']);
      expect(after.properties.record).toEqual({ type: 'array', items: { type: 'object', properties: { id: { type: 'string', pattern: '^r_[0-9a-f]{12}$' } }, additionalProperties: false, required: ['id'] }, maxItems: 2 });
      for (const key of Object.keys(before.properties)) expect(after.properties[key], `${name}.${key}`).toEqual(before.properties[key]);
    }
    // every other tool is the same object
    for (const tool of with_) if (tool.name !== 'publish_post' && tool.name !== 'schedule_post') expect(tool).toBe(plain.find((t) => t.name === tool.name));
    // the account's limit and the other optional fields still combine with it
    expect(toolsFor(config, { premium: false, records: true }).find((t) => t.name === 'publish_post')!.description).toBe(publishPostDescription(280, { record: true }));
    expect(publishPostDescription(4000, { threadMore: 0, comments: false, topic: false, record: true }).endsWith(`generate_image.${RECORD_FIELD_SENTENCE}`)).toBe(true);
    expect(Object.keys(publishPostInput({ threadMore: 0, comments: false, topic: false, record: true }).shape)).toEqual(['text', 'attributions', 'imageId', 'record']);
  });
});
