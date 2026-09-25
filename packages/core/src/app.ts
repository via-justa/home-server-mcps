import path from 'node:path';
import { ApprovalService } from './approvals/service.js';
import { McpTokenService } from './auth/mcp-tokens.js';
import { OidcService } from './auth/oidc.js';
import { SessionService } from './auth/sessions.js';
import { LoginThrottle } from './auth/throttle.js';
import { UserService } from './auth/users.js';
import type { Config } from './config/env.js';
import { loadMasterKey, SecretBox } from './crypto/index.js';
import { openDatabase } from './db/index.js';
import type { Db } from './db/index.js';
import { CoreEvents } from './events.js';
import { SlidingWindowLimiter } from './gate/rate-limit.js';
import type { GateDeps } from './gate/pipeline.js';
import { InstanceManager } from './instances/manager.js';
import type { ManagerOptions } from './instances/manager.js';
import { discoverPlugins, syncPluginRegistry } from './plugins/discovery.js';

/**
 * Wires every core service together once (design §2). Both listeners, the scheduler and tests use
 * the same context, so there is exactly one database handle, one approval service, one event bus.
 */

export interface AppContext {
  config: Config;
  db: Db;
  secrets: SecretBox;
  events: CoreEvents;
  users: UserService;
  sessions: SessionService;
  throttle: LoginThrottle;
  oidc: OidcService;
  tokens: McpTokenService;
  instances: InstanceManager;
  approvals: ApprovalService;
  limiter: SlidingWindowLimiter;
  keys: { attestation: Buffer; state: Buffer; approvalLinks: Buffer };
  warnings: string[];
  now: () => Date;
  gateDeps(): GateDeps;
  /** Re-scan plugin directories and update the registry (startup, after installs). */
  discoverPlugins(): ReturnType<typeof syncPluginRegistry>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface AppOptions {
  now?: () => Date;
  supervisor?: ManagerOptions['supervisor'];
  /** Allow http:// OIDC issuers (tests, lab IdPs). */
  oidcAllowInsecure?: boolean;
  /** Use an in-memory database (tests). */
  memoryDb?: boolean;
}

export async function createAppContext(config: Config, opts: AppOptions = {}): Promise<AppContext> {
  const now = opts.now ?? (() => new Date());
  const warnings: string[] = [];
  const master = loadMasterKey({ envKey: config.MASTER_KEY, dataDir: config.DATA_DIR });
  if (master.warning) warnings.push(master.warning);
  const secrets = SecretBox.fromKey(master.key);

  const db = opts.memoryDb ? openDatabase(':memory:') : openDatabase({ dataDir: config.DATA_DIR });
  const orphans = ApprovalService.denyOrphans(db);
  if (orphans > 0) warnings.push(`Denied ${orphans} approval(s) left pending by the previous run`);

  const events = new CoreEvents();
  const users = new UserService(db, secrets);
  const boot = await users.bootstrap(config.ADMIN_BOOTSTRAP_USERNAME, config.ADMIN_BOOTSTRAP_PASSWORD);
  if (boot === 'created')
    warnings.push(`Created admin user "${config.ADMIN_BOOTSTRAP_USERNAME}" from ADMIN_BOOTSTRAP_*`);
  if (boot === 'ignored') warnings.push('ADMIN_BOOTSTRAP_* is set but users already exist; it is ignored — remove it');

  const instances = new InstanceManager({ db, secrets, events, now, supervisor: opts.supervisor });
  const approvals = new ApprovalService(db, now);
  const slugOf = (instanceId: string) => {
    try {
      return instances.get(instanceId).slug;
    } catch {
      return '';
    }
  };
  approvals.on('pending', (a) =>
    events.emit('approval.pending', {
      approvalId: a.id,
      instanceId: a.instanceId,
      slug: slugOf(a.instanceId),
      operationKey: a.operationKey,
      summary: a.summary,
      expiresAt: a.expiresAt,
    }),
  );
  approvals.on('decided', (a) =>
    events.emit('approval.decided', {
      approvalId: a.id,
      instanceId: a.instanceId,
      slug: slugOf(a.instanceId),
      operationKey: a.operationKey,
      outcome: a.decision.outcome,
      via: a.decision.via,
      decidedBy: a.decision.decidedBy,
    }),
  );

  const keys = {
    attestation: secrets.deriveKey('attestation'),
    state: secrets.deriveKey('signed-state'),
    approvalLinks: secrets.deriveKey('approval-links'),
  };
  const limiter = new SlidingWindowLimiter();
  const discover = () =>
    syncPluginRegistry(
      db,
      discoverPlugins([
        { dir: config.CORE_PLUGINS_DIR, source: 'core' },
        { dir: path.join(config.DATA_DIR, 'plugins'), source: 'repo' },
      ]),
      { autoEnableCore: config.CORE_PLUGINS_AUTOENABLE },
    );
  const registered = discover();
  for (const id of registered.rejected) warnings.push(`Plugin ${id} was ignored: its id is already taken`);

  const timers: NodeJS.Timeout[] = [];
  const ctx: AppContext = {
    config,
    db,
    secrets,
    events,
    users,
    sessions: new SessionService(db, secrets.deriveKey('session-pepper'), now),
    throttle: new LoginThrottle(),
    oidc: new OidcService(db, secrets, keys.state, opts.oidcAllowInsecure ?? false),
    tokens: new McpTokenService(db, now),
    instances,
    approvals,
    limiter,
    keys,
    warnings,
    now,
    gateDeps: () => ({ db, approvals, limiter, attestationKey: keys.attestation, now }),
    discoverPlugins: discover,
    async start() {
      await instances.startAll();
      // Daily backstop sync (design §10), checked hourly so instances don't all sync at once.
      timers.push(setInterval(() => void instances.syncStale(), 60 * 60_000).unref());
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      approvals.cancelAll('shutdown');
      await instances.stopAll();
      db.$client.close();
    },
  };
  return ctx;
}
