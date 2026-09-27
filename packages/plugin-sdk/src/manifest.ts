import semver from 'semver';
import { z } from 'zod';
import { SDK_VERSION } from './version.js';

/**
 * Core widget library (design §8.3). Plugins can only reference these; an unknown widget fails
 * validation instead of silently degrading to a free-text field.
 */
export const WIDGETS = [
  'text',
  'url',
  'number',
  'bool',
  'select',
  'secret',
  'multiselect',
  'prefix',
  'range',
  'registry-picker',
  'diff',
] as const;
export type Widget = (typeof WIDGETS)[number];

/** Operators understood by the core pre-approval match evaluator (design §5.2). */
export const MATCH_OPS = ['eq', 'in', 'prefix', 'range', 'bool'] as const;
export type MatchOp = (typeof MATCH_OPS)[number];

/** Sandbox globals owned by core; a plugin binding namespace may not shadow them. */
export const RESERVED_NAMESPACES = ['catalog', 'registry', 'guides', 'console'] as const;

const pluginId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'lowercase letters, digits and dashes');
const jsIdentifier = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, 'must be a JavaScript identifier');
const jsonSchema = z.record(z.string(), z.unknown());

const relativePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.split(/[\\/]/).includes('..'), 'must be a relative path inside the package');

export const UiHintSchema = z.object({
  widget: z.enum(WIDGETS).optional(),
  help: z.string().optional(),
  placeholder: z.string().optional(),
  optionsSource: z.string().optional(),
  /** Show the field only while another connection field has one of these values (e.g. an auth-method select). */
  showWhen: z
    .object({
      field: z.string().min(1),
      in: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1),
    })
    .optional(),
});
export type UiHint = z.infer<typeof UiHintSchema>;

export const MatchFieldSchema = z
  .object({
    /** JSON pointer into the normalized params (`/name`), or `$targets` for the resolved-target selector. */
    field: z.string().regex(/^(\$targets|\/.*)$/, 'must be a JSON pointer or $targets'),
    label: z.string().min(1),
    op: z.enum(MATCH_OPS).optional(),
    widget: z.enum(WIDGETS),
    options: z.record(z.string(), z.unknown()).optional(),
    /** Source name passed to the plugin's `optionsFor` RPC to populate pickers. */
    optionsSource: z.string().optional(),
    /**
     * `$targets` only: the params subtree the target selector stands for (e.g. `/selector`). A rule with a
     * `$targets` condition already checks every resolved target, so core lets it cover that subtree
     * under strict matching instead of requiring an "any value" condition on it.
     */
    covers: z.string().regex(/^\/.+/, 'must be a JSON pointer').optional(),
  })
  .superRefine((f, ctx) => {
    if (f.field === '$targets') {
      if (f.widget !== 'registry-picker') {
        ctx.addIssue({ code: 'custom', message: '$targets fields must use the registry-picker widget' });
      }
    } else if (f.covers) {
      ctx.addIssue({ code: 'custom', message: 'only $targets fields can declare covers' });
    } else if (!f.op) {
      ctx.addIssue({ code: 'custom', message: 'param match fields must declare an op' });
    }
  });
export type MatchField = z.infer<typeof MatchFieldSchema>;

export const ManifestSchema = z
  .object({
    id: pluginId,
    name: z.string().min(1),
    version: z.string().refine((v) => semver.valid(v) !== null, 'must be a semver version'),
    sdk: z.string().refine((r) => semver.validRange(r) !== null, 'must be a semver range'),
    description: z.string().optional(),
    entry: relativePath,
    binding: z.object({
      namespace: jsIdentifier,
      functions: z.array(jsIdentifier).min(1),
      searchApis: z.array(z.enum(['registry', 'guides'])).default([]),
    }),
    labels: z
      .object({
        operation: z.string().default('Operation'),
        operations: z.string().default('Operations'),
      })
      .prefault({}),
    capabilities: z
      .object({
        registry: z.boolean().default(false),
        targets: z.boolean().default(false),
        attestation: z.boolean().default(false),
        configTransform: z.boolean().default(false),
      })
      .prefault({}),
    connection: z.object({
      schema: jsonSchema,
      ui: z.record(z.string(), UiHintSchema).default({}),
      /** Setup instructions shown on the Connection page (Markdown). */
      help: z.string().optional(),
    }),
    sensitiveKeys: z.array(z.string().min(1)).default([]),
    network: z.object({ hosts: z.array(z.string()).default([]) }).prefault({}),
    matchProfiles: z.record(z.string(), z.array(MatchFieldSchema)).default({}),
  })
  .superRefine((m, ctx) => {
    if ((RESERVED_NAMESPACES as readonly string[]).includes(m.binding.namespace)) {
      ctx.addIssue({
        code: 'custom',
        path: ['binding', 'namespace'],
        message: `"${m.binding.namespace}" is reserved by core`,
      });
    }
    if (m.binding.searchApis.includes('registry') && !m.capabilities.registry) {
      ctx.addIssue({
        code: 'custom',
        path: ['binding', 'searchApis'],
        message: 'registry requires capabilities.registry',
      });
    }
    if (m.binding.searchApis.includes('guides') && !m.capabilities.attestation) {
      ctx.addIssue({
        code: 'custom',
        path: ['binding', 'searchApis'],
        message: 'guides requires capabilities.attestation',
      });
    }
    const properties = m.connection.schema.properties;
    const fieldNames = new Set(
      typeof properties === 'object' && properties !== null ? Object.keys(properties as object) : [],
    );
    for (const [name, hint] of Object.entries(m.connection.ui)) {
      if (!fieldNames.has(name)) {
        ctx.addIssue({ code: 'custom', path: ['connection', 'ui', name], message: 'no such connection field' });
      }
      if (hint.showWhen && (hint.showWhen.field === name || !fieldNames.has(hint.showWhen.field))) {
        ctx.addIssue({
          code: 'custom',
          path: ['connection', 'ui', name, 'showWhen', 'field'],
          message: 'must reference another connection field',
        });
      }
    }
    for (const [profile, fields] of Object.entries(m.matchProfiles)) {
      if (fields.some((f) => f.field === '$targets') && !m.capabilities.targets) {
        ctx.addIssue({
          code: 'custom',
          path: ['matchProfiles', profile],
          message: '$targets match fields require capabilities.targets',
        });
      }
    }
  });
export type Manifest = z.infer<typeof ManifestSchema>;

/** Parses and validates a manifest. Throws a `ZodError` describing every problem found. */
export function parseManifest(input: unknown): Manifest {
  return ManifestSchema.parse(input);
}

/** Whether a manifest's `sdk` range accepts the contract version implemented by core. */
export function isSdkCompatible(manifest: Pick<Manifest, 'sdk'>, sdkVersion: string = SDK_VERSION): boolean {
  return semver.satisfies(sdkVersion, manifest.sdk);
}
