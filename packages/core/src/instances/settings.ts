import { z } from 'zod';

/** Per-instance runtime settings (design §8.2 "Instance Settings"), stored as JSON on `plugin_instances.settings`. */
export const InstanceSettingsSchema = z
  .object({
    /** Unanswered approvals are auto-denied after this long (TN §3.3). */
    approvalTimeoutMs: z
      .number()
      .int()
      .min(10_000)
      .max(24 * 60 * 60_000)
      .default(15 * 60_000),
    /**
     * Let MCP clients that only support form prompts approve plain writes (never locked or
     * typed-confirmation operations). Off by default: any client on this endpoint could then approve
     * its own writes. URL prompts (a signed-in human on the approval page) always work.
     */
    formElicitationApprovals: z.enum(['off', 'writes']).default('off'),
    executePerMinute: z.number().int().min(1).max(10_000).default(30),
    writesPerMinute: z.number().int().min(1).max(10_000).default(10),
    sandbox: z
      .object({
        timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
        memoryMb: z.number().int().min(8).max(1024).default(64),
        maxResultBytes: z
          .number()
          .int()
          .min(1024)
          .max(4 * 1024 * 1024)
          .default(64 * 1024),
      })
      .prefault({}),
    extraRedactKeys: z.array(z.string().min(1)).default([]),
    /** Re-sync the catalog on session start when the last sync is older than this (TN §5). */
    syncMaxAgeMs: z
      .number()
      .int()
      .min(60_000)
      .max(7 * 24 * 60 * 60_000)
      .default(60 * 60_000),
    /** Plugin child heap limit (design §4.4). */
    memoryMb: z.number().int().min(64).max(4096).default(256),
  })
  .prefault({});

export type InstanceSettings = z.infer<typeof InstanceSettingsSchema>;

export function parseInstanceSettings(raw: unknown): InstanceSettings {
  return InstanceSettingsSchema.parse(raw ?? {});
}
