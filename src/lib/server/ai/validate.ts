// Minimal JSON-Schema validator for the subset our stage schemas use: object / array /
// string / number / integer / boolean, `required`, `enum`, `const`, `minItems`,
// `minLength`, `additionalProperties: false`. Deliberately dependency-free and a LEAF
// module (no imports) so the test suite can import it directly with
// `--experimental-strip-types`. Failures return the JSON path of every violation —
// those messages are fed back to the model on the single retry.

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<string | number | boolean | null>;
  const?: string | number | boolean | null;
  minItems?: number;
  minLength?: number;
  additionalProperties?: boolean;
  description?: string;
};

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validateNode(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  if (schema.const !== undefined) {
    if (value !== schema.const) errors.push(`${path}: must be exactly ${JSON.stringify(schema.const)}`);
    return;
  }
  if (schema.enum) {
    if (!schema.enum.includes(value as string | number | boolean | null)) {
      errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
    }
    return;
  }

  const expected = schema.type;
  if (!expected) return;

  const actual = typeOf(value);
  if (expected === 'integer') {
    if (actual !== 'number' || !Number.isInteger(value)) {
      errors.push(`${path}: expected integer, got ${actual === 'number' ? 'non-integer number' : actual}`);
      return;
    }
  } else if (actual !== expected) {
    errors.push(`${path}: expected ${expected}, got ${actual}`);
    return;
  }

  if (expected === 'string' && typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: must be at least ${schema.minLength} characters`);
    }
  }

  if (expected === 'array' && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: must have at least ${schema.minItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((entry, index) => validateNode(entry, schema.items as JsonSchema, `${path}[${index}]`, errors));
    }
  }

  if (expected === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required || []) {
      if (!(key in record)) errors.push(`${path}.${key}: required property is missing`);
    }
    const properties = schema.properties || {};
    for (const [key, entry] of Object.entries(record)) {
      const propSchema = properties[key];
      if (propSchema) {
        validateNode(entry, propSchema, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: unexpected property`);
      }
    }
  }
}

export function validateAgainstSchema(value: unknown, schema: JsonSchema): ValidationResult {
  const errors: string[] = [];
  validateNode(value, schema, '$', errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
