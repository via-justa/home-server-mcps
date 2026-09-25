import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/config or dist/config → repository/workspace root is three levels up.
const workspaceRoot = path.resolve(here, '../../../..');

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const port = z.coerce.number().int().min(0).max(65535);
const optionalUrl = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined))
  .pipe(z.url().optional());

const EnvSchema = z
  .object({
    DATA_DIR: z.string().default('/data'),
    MASTER_KEY: z.string().optional(),
    MCP_HOST: z.string().default('0.0.0.0'),
    MCP_PORT: port.default(8080),
    ADMIN_HOST: z.string().default('0.0.0.0'),
    ADMIN_PORT: port.default(8081),
    PUBLIC_MCP_URL: optionalUrl,
    PUBLIC_ADMIN_URL: optionalUrl,
    TRUST_PROXY: bool,
    CORE_PLUGINS_AUTOENABLE: bool,
    CORE_PLUGINS_DIR: z.string().default(path.join(workspaceRoot, 'plugins')),
    ADMIN_UI_DIR: z.string().default(path.join(workspaceRoot, 'packages/admin-ui/dist')),
    ADMIN_BOOTSTRAP_USERNAME: z.string().optional(),
    ADMIN_BOOTSTRAP_PASSWORD: z.string().optional(),
    ADMIN_FORCE_LOCAL_LOGIN: bool,
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  .refine((e) => e.MCP_PORT === 0 || e.MCP_PORT !== e.ADMIN_PORT, {
    message: 'MCP_PORT and ADMIN_PORT must differ',
    path: ['ADMIN_PORT'],
  });

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return EnvSchema.parse(env);
}
