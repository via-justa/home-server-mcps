import type { Manifest } from '@home-server-mcps/plugin-sdk';
import { Ajv } from 'ajv';
import type { ErrorObject } from 'ajv';
import * as ajvFormats from 'ajv-formats';
import { ValidationError } from '../errors.js';

// ajv-formats ships CJS (`exports.default = formatsPlugin`); normalize that for NodeNext ESM.
type FormatsPlugin = (ajv: Ajv) => Ajv;
const addFormats = ((ajvFormats as unknown as { default: { default?: FormatsPlugin } & FormatsPlugin }).default
  .default ?? (ajvFormats as unknown as { default: FormatsPlugin }).default) as FormatsPlugin;

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
addFormats(ajv);

/**
 * Connection config handling (design §7.2, §8.3). Fields marked `writeOnly` in the plugin's
 * connection schema are secrets: stored encrypted, passed to the plugin only via `init`, and never
 * returned by the API — only a `{ set, hint }` summary.
 */

export function secretFieldNames(manifest: Manifest): string[] {
  const props = (manifest.connection.schema.properties ?? {}) as Record<string, { writeOnly?: boolean }>;
  return Object.entries(props)
    .filter(([, p]) => p?.writeOnly === true)
    .map(([k]) => k);
}

const describeErrors = (errors: ErrorObject[] | null | undefined) =>
  (errors ?? []).map((e) => `${e.instancePath || '(connection)'} ${e.message ?? 'is invalid'}`.trim());

/** Validates the merged config + secrets against the plugin's schema and splits them again. */
export function validateConnection(
  manifest: Manifest,
  input: Record<string, unknown>,
): { config: Record<string, unknown>; secrets: Record<string, string> } {
  const validate = ajv.compile(manifest.connection.schema);
  const candidate = structuredClone(input);
  if (!validate(candidate)) {
    throw new ValidationError('invalid_connection', 'Connection settings are invalid', describeErrors(validate.errors));
  }
  const secretNames = new Set(secretFieldNames(manifest));
  const config: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(candidate)) {
    if (secretNames.has(k)) {
      if (v !== undefined && v !== null && v !== '') secrets[k] = String(v);
    } else {
      config[k] = v;
    }
  }
  return { config, secrets };
}

/**
 * Applies a secrets patch: a provided non-empty value replaces, `null` clears, an omitted key keeps
 * the stored value. Unknown keys are rejected so typos don't silently drop a credential.
 */
export function mergeSecrets(
  manifest: Manifest,
  current: Record<string, string>,
  patch: Record<string, string | null | undefined>,
): Record<string, string> {
  const names = new Set(secretFieldNames(manifest));
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (!names.has(k)) throw new ValidationError('unknown_secret', `"${k}" is not a secret field of this plugin`);
    if (v === null) delete next[k];
    else if (v !== undefined && v !== '') next[k] = v;
  }
  return next;
}

export interface SecretSummary {
  set: boolean;
  /** Last 4 characters, only for values long enough that this reveals little. */
  hint?: string;
}

export function summarizeSecrets(manifest: Manifest, secrets: Record<string, string>): Record<string, SecretSummary> {
  return Object.fromEntries(
    secretFieldNames(manifest).map((name) => {
      const v = secrets[name];
      return [name, v ? { set: true, ...(v.length >= 12 ? { hint: `…${v.slice(-4)}` } : {}) } : { set: false }];
    }),
  );
}
