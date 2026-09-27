import { MATCH_OPS } from '@synoikia/plugin-sdk';
import type { ResolvedTarget } from '@synoikia/plugin-sdk';
import { z } from 'zod';
import { canonicalJson } from './canonical.js';

/**
 * Pre-approval `match` evaluator (design §5.2). A rule's match is a list of conditions that must all
 * hold. It fails closed: a missing field, a type mismatch or zero resolved targets means "no match",
 * which only ever sends the call to a human.
 *
 * Matching is **strict**: every parameter of the call must be covered by a condition. A parameter the
 * rule doesn't mention must be absent, unless the rule accepts it with `{ field, op: 'any' }` (`field: ''`
 * accepts all parameters). Otherwise a rule for one field would also approve whatever else the model
 * chose to send (a quota, an ACL, encryption options).
 */

export const PARAM_OPS = [...MATCH_OPS, 'any'] as const;

export const ParamConditionSchema = z
  .object({
    field: z.string().regex(/^(\/.*)?$/, 'must be a JSON pointer'),
    op: z.enum(PARAM_OPS),
    value: z.unknown().optional(),
  })
  .refine((c) => c.op === 'any' || c.field !== '', 'only "any" can apply to all parameters');

export const TargetConditionSchema = z
  .object({
    field: z.literal('$targets'),
    areas: z.array(z.string()).optional(),
    entities: z.array(z.string()).optional(),
    domains: z.array(z.string()).optional(),
  })
  .refine(
    (c) => c.areas?.length || c.entities?.length || c.domains?.length,
    'select at least one area, entity or domain',
  );

export const MatchSchema = z.array(z.union([TargetConditionSchema, ParamConditionSchema]));
export type MatchCondition = z.infer<typeof MatchSchema>[number];

const MISSING = Symbol('missing');

/** RFC 6901 JSON pointer lookup; returns MISSING instead of undefined so `null` values still count. */
export function getPointer(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, key)) return MISSING;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function paramMatches(actual: unknown, op: string, expected: unknown): boolean {
  if (op === 'any') return true; // present or not, any value
  if (actual === MISSING) return false;
  switch (op) {
    case 'eq':
      return canonicalJson(actual) === canonicalJson(expected);
    case 'in': {
      if (!Array.isArray(expected)) return false;
      const allowed = new Set(expected.map((v) => canonicalJson(v)));
      const values = Array.isArray(actual) ? actual : [actual];
      return values.length > 0 && values.every((v) => allowed.has(canonicalJson(v)));
    }
    case 'prefix':
      // Path-segment boundary: "tank/media" matches "tank/media" and "tank/media/tv", not "tank/media-private".
      return (
        typeof actual === 'string' &&
        typeof expected === 'string' &&
        expected !== '' &&
        (actual === expected ||
          (actual.startsWith(expected) && (expected.endsWith('/') || actual[expected.length] === '/')))
      );
    case 'range': {
      const { min, max } = (expected ?? {}) as { min?: unknown; max?: unknown };
      if (typeof actual !== 'number' || !Number.isFinite(actual)) return false;
      if (min === undefined && max === undefined) return false;
      if (min !== undefined && (typeof min !== 'number' || actual < min)) return false;
      if (max !== undefined && (typeof max !== 'number' || actual > max)) return false;
      return true;
    }
    case 'bool':
      return typeof actual === 'boolean' && actual === expected;
    default:
      return false;
  }
}

function targetMatches(target: ResolvedTarget, c: z.infer<typeof TargetConditionSchema>): boolean {
  if (c.areas?.length && !c.areas.includes(target.scopes?.area ?? '')) return false;
  if (c.entities?.length && !c.entities.includes(target.id)) return false;
  if (c.domains?.length && !c.domains.includes(target.scopes?.domain ?? '')) return false;
  return true;
}

const escapePointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * Whether every parameter is covered by some condition: a condition on a path covers everything under
 * it; an object or array only partly covered has each of its keys (or indexes: `/0/name`) checked in
 * turn. Nothing (or `{}` / `[]`) is covered. Arrays matter for positional APIs such as TrueNAS, whose
 * params are `[{ name, … }]`.
 */
export function coversAllParams(match: readonly MatchCondition[], params: unknown): boolean {
  const pointers = match.filter((c) => c.field !== '$targets').map((c) => c.field);
  const covered = (value: unknown, path: string): boolean => {
    if (pointers.includes(path)) return true;
    if (value === undefined || value === null) return path === '';
    if (typeof value !== 'object') return false;
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
    if (entries.length === 0) return true;
    if (!pointers.some((p) => p.startsWith(`${path}/`))) return false;
    return entries.every(([k, v]) => covered(v, `${path}/${escapePointer(k)}`));
  };
  return covered(params, '');
}

/** The conditions alone, without the strict every-parameter check (used to spot rules strictness broke). */
export function conditionsHold(
  match: readonly MatchCondition[],
  call: { params: unknown; targets: readonly ResolvedTarget[] },
): boolean {
  return match.every((c) => {
    if (c.field === '$targets') {
      const tc = c as z.infer<typeof TargetConditionSchema>;
      return call.targets.length > 0 && call.targets.every((t) => targetMatches(t, tc));
    }
    const pc = c as z.infer<typeof ParamConditionSchema>;
    return paramMatches(getPointer(call.params, pc.field), pc.op, pc.value);
  });
}

export function matches(
  match: readonly MatchCondition[],
  call: { params: unknown; targets: readonly ResolvedTarget[] },
): boolean {
  return conditionsHold(match, call) && coversAllParams(match, call.params);
}
