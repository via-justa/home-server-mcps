import { z } from 'zod';

/**
 * Shapes a plugin returns over RPC. Core treats plugin output as untrusted and validates every
 * result against these schemas before using it (design §3.3).
 */

export const OperationDescriptorSchema = z.object({
  /** Stable catalog key, unique per instance: `pool.query`, `POST /request`, `light.turn_on`. */
  key: z.string().min(1).max(512),
  displayName: z.string().optional(),
  /** Plugin-defined kind: 'method' | 'rest' | 'service' | 'ws_command' … */
  kind: z.string().min(1),
  /**
   * Access group: admins set one none/read/write level per group instead of toggling each operation
   * (design §5.2). Derived during discovery: TrueNAS namespace, Seerr OpenAPI tag, HA domain.
   */
  group: z
    .string()
    .max(128)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, dots, dashes and underscores'),
  groupLabel: z.string().max(128).optional(),
  /** Free-form tag for filtering/display; not used for access. */
  tag: z.string().optional(),
  /** The plugin's inferred default. Core applies locked ▸ override ▸ inferred on top. */
  classification: z.enum(['read', 'write']),
  classificationReason: z.string().min(1),
  locked: z.boolean().default(false),
  /** Defaults to `locked` when omitted. */
  typedConfirmation: z.boolean().optional(),
  attestationRequired: z.boolean().default(false),
  /** Flags the operation for explicit admin review (e.g. Seerr GET-as-action, unknown HA WS command). */
  needsReview: z.boolean().default(false),
  matchProfile: z.string().optional(),
  paramsSchema: z.record(z.string(), z.unknown()).optional(),
  docs: z
    .object({
      summary: z.string().optional(),
      description: z.string().optional(),
      guidance: z.string().optional(),
    })
    .optional(),
});
export type OperationDescriptor = z.input<typeof OperationDescriptorSchema>;
export type ParsedOperationDescriptor = z.output<typeof OperationDescriptorSchema>;

export const SyncCatalogResultSchema = z.object({
  upstreamVersion: z.string(),
  /** Where the catalog came from, e.g. the Seerr git ref the spec was fetched from. */
  sourceRef: z.string().optional(),
  operations: z.array(OperationDescriptorSchema),
});
export type SyncCatalogResult = z.input<typeof SyncCatalogResultSchema>;

export const RegistryEntrySchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
  name: z.string(),
  parentId: z.string().optional(),
  domain: z.string().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

export const ResolvedTargetSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
  name: z.string(),
  /** Ancestors used by `$targets` selectors, e.g. `{ area: 'living_room', domain: 'light' }`. */
  scopes: z.record(z.string(), z.string()).default({}),
});
export type ResolvedTarget = z.input<typeof ResolvedTargetSchema>;

export const ResolveOperationResultSchema = z.object({
  key: z.string().min(1),
  params: z.unknown(),
});
export type ResolveOperationResult = z.infer<typeof ResolveOperationResultSchema>;

export const SummarizeResultSchema = z.object({
  text: z.string().min(1),
  /** Literal the approver must type for typed-confirmation operations. */
  confirmLiteral: z.string().min(1).optional(),
});
export type SummarizeResult = z.infer<typeof SummarizeResultSchema>;

export const PrepareWriteResultSchema = z.object({
  params: z.unknown(),
  diff: z.array(
    z.object({
      path: z.string(),
      before: z.unknown().optional(),
      after: z.unknown().optional(),
    }),
  ),
  expectedHash: z.string().min(1),
});
export type PrepareWriteResult = z.infer<typeof PrepareWriteResultSchema>;

export const TestConnectionResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  upstreamVersion: z.string().optional(),
});
export type TestConnectionResult = z.infer<typeof TestConnectionResultSchema>;

export const OptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type Option = z.infer<typeof OptionSchema>;

export const GuideSchema = z.object({
  version: z.string().min(1),
  content: z.string(),
});
export type Guide = z.infer<typeof GuideSchema>;
