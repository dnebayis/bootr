import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from './json-schema.js';

describe('zodToJsonSchema', () => {
  it('projects objects, arrays, numbers, unions and defaults', () => {
    const schema = z.object({
      name: z.string().min(1).max(10),
      count: z.number().int().min(0).max(5).optional(),
      tags: z.array(z.enum(['a', 'b'])).max(3),
      kind: z.union([z.literal('x'), z.literal('y')]),
      flag: z.boolean().default(true),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['name', 'tags', 'kind'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 10 },
        count: { type: 'integer', minimum: 0, maximum: 5 },
        tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, maxItems: 3 },
        kind: { anyOf: [{ const: 'x' }, { const: 'y' }] },
        flag: { type: 'boolean', default: true },
      },
    });
  });
});
