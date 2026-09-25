import path from 'node:path';
import { ApprovalService } from './approvals/service.js';
import type { Config } from './config/env.js';
import { loadMasterKey, SecretBox } from './crypto/index.js';
import { openDatabase } from './db/index.js';
import type { Db } from './db/index.js';
import { discoverPlugins, syncPluginRegistry } from './plugins/discovery.js';

export interface Core {
  db: Db;
  secrets: SecretBox;
  warnings: string[];
  plugins: ReturnType<typeof syncPluginRegistry>;
}

/**
 * Startup before the listeners open: master key, database + migrations, plugin discovery.
 * Instances are started by the plugin host once instance management lands (design §13, phase 12).
 */
export function bootstrap(config: Config): Core {
  const warnings: string[] = [];
  const master = loadMasterKey({ envKey: config.MASTER_KEY, dataDir: config.DATA_DIR });
  if (master.warning) warnings.push(master.warning);

  const db = openDatabase({ dataDir: config.DATA_DIR });
  const orphans = ApprovalService.denyOrphans(db);
  if (orphans > 0) warnings.push(`Denied ${orphans} approval(s) left pending by the previous run`);
  const discovered = discoverPlugins([
    { dir: config.CORE_PLUGINS_DIR, source: 'core' },
    { dir: path.join(config.DATA_DIR, 'plugins'), source: 'repo' },
  ]);
  const plugins = syncPluginRegistry(db, discovered, { autoEnableCore: config.CORE_PLUGINS_AUTOENABLE });
  for (const p of discovered) {
    if (p.status !== 'ok') warnings.push(`Plugin ${p.pluginId} (${p.dir}) is ${p.status}: ${p.error}`);
  }
  for (const id of plugins.rejected) warnings.push(`Plugin ${id} was ignored: its id is already taken`);

  return { db, secrets: SecretBox.fromKey(master.key), warnings, plugins };
}
