import { z } from 'zod';

export type JsonSchema = Record<string, unknown>;

/**
 * Minimal zod -> JSON Schema projection covering the types used by the tool
 * catalog (object, string, number, boolean, enum, literal, array, union of
 * literals, optional/default/nullable). Anything else becomes `{}`.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = schema._def as { typeName: z.ZodFirstPartyTypeKind } & Record<string, unknown>;
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!value.isOptional()) required.push(key);
      }
      const out: JsonSchema = { type: 'object', properties, additionalProperties: false };
      if (required.length) out.required = required;
      return out;
    }
    case z.ZodFirstPartyTypeKind.ZodString: {
      const out: JsonSchema = { type: 'string' };
      for (const check of (def.checks as { kind: string; value?: unknown; regex?: RegExp }[]) ?? []) {
        if (check.kind === 'min') out.minLength = check.value;
        if (check.kind === 'max') out.maxLength = check.value;
        if (check.kind === 'regex' && check.regex) out.pattern = check.regex.source;
      }
      return out;
    }
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const checks = (def.checks as { kind: string; value?: number }[]) ?? [];
      const out: JsonSchema = { type: checks.some((c) => c.kind === 'int') ? 'integer' : 'number' };
      for (const check of checks) {
        if (check.kind === 'min') out.minimum = check.value;
        if (check.kind === 'max') out.maximum = check.value;
      }
      return out;
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: 'boolean' };
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return { const: def.value };
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return { type: 'string', enum: [...(def.values as string[])] };
    case z.ZodFirstPartyTypeKind.ZodArray: {
      const out: JsonSchema = { type: 'array', items: zodToJsonSchema(def.type as z.ZodTypeAny) };
      const min = def.minLength as { value: number } | null;
      const max = def.maxLength as { value: number } | null;
      if (min) out.minItems = min.value;
      if (max) out.maxItems = max.value;
      return out;
    }
    case z.ZodFirstPartyTypeKind.ZodUnion:
      return { anyOf: (def.options as z.ZodTypeAny[]).map(zodToJsonSchema) };
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodNullable:
      return zodToJsonSchema(def.innerType as z.ZodTypeAny);
    case z.ZodFirstPartyTypeKind.ZodDefault:
      return { ...zodToJsonSchema(def.innerType as z.ZodTypeAny), default: (def.defaultValue as () => unknown)() };
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return zodToJsonSchema(def.schema as z.ZodTypeAny);
    default:
      return {};
  }
}
