import type { InitParams } from '@home-server-mcps/plugin-sdk';
import { SDK_VERSION } from '@home-server-mcps/plugin-sdk';
import { PluginProcess, PluginUnavailableError } from './process.js';
import type { SpawnOptions } from './process.js';

/**
 * Keeps one plugin instance's child process alive (design §4.4): spawn → `init` → ready. On an
 * unexpected exit the instance goes to `error` and restarts with exponential backoff. A crashed or
 * restarting plugin never makes the gate fail open: callers just get `PluginUnavailableError`.
 */

export type InstanceStatus = 'stopped' | 'starting' | 'ready' | 'error';

export interface SupervisorOptions extends SpawnOptions {
  /** Called on every start with this instance's config and freshly decrypted secrets. */
  loadInit: () => Omit<InitParams, 'sdkVersion' | 'instanceId'>;
  onStatus?: (status: InstanceStatus, error?: string) => void;
  onLog?: (level: string, message: string) => void;
  onCatalogChanged?: (reason?: string) => void;
  initTimeoutMs?: number;
  backoff?: { initialMs: number; maxMs: number };
}

export class PluginSupervisor {
  private proc?: PluginProcess;
  private _status: InstanceStatus = 'stopped';
  private stopping = false;
  private restartTimer?: NodeJS.Timeout;
  private attempt = 0;
  private generation = 0;

  constructor(private readonly opts: SupervisorOptions) {}

  get status(): InstanceStatus {
    return this._status;
  }

  /** The live process for RPC calls. Throws unless the instance is ready. */
  get client(): PluginProcess {
    if (this._status !== 'ready' || !this.proc?.running) throw new PluginUnavailableError();
    return this.proc;
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.spawn();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.generation++;
    clearTimeout(this.restartTimer);
    const proc = this.proc;
    this.proc = undefined;
    await proc?.stop();
    this.setStatus('stopped');
  }

  /** Restart now (e.g. after the admin changed the connection config or secrets). */
  async restart(): Promise<void> {
    await this.stop();
    this.attempt = 0;
    await this.start();
  }

  private setStatus(status: InstanceStatus, error?: string) {
    this._status = status;
    this.opts.onStatus?.(status, error);
  }

  private async spawn(): Promise<void> {
    const generation = ++this.generation;
    this.setStatus('starting');
    const proc = new PluginProcess(this.opts);
    this.proc = proc;
    proc.on('log', (level, message) => this.opts.onLog?.(level, message));
    proc.on('catalogChanged', (reason) => this.opts.onCatalogChanged?.(reason));
    proc.on('exit', (code, signal) => {
      if (this.stopping || generation !== this.generation) return;
      this.scheduleRestart(`plugin exited unexpectedly (${signal ?? `code ${code}`})`);
    });
    try {
      proc.start();
      await proc.call(
        'init',
        { ...this.opts.loadInit(), instanceId: this.opts.instanceId, sdkVersion: SDK_VERSION },
        this.opts.initTimeoutMs ?? 30_000,
      );
    } catch (err) {
      if (generation !== this.generation) return;
      proc.kill();
      this.scheduleRestart(`init failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (generation !== this.generation) return;
    this.attempt = 0;
    this.setStatus('ready');
  }

  private scheduleRestart(reason: string) {
    if (this.stopping) return;
    this.generation++;
    this.proc = undefined;
    this.setStatus('error', reason);
    const { initialMs, maxMs } = this.opts.backoff ?? { initialMs: 1000, maxMs: 60_000 };
    const delay = Math.min(maxMs, initialMs * 2 ** this.attempt++);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      if (!this.stopping) void this.spawn();
    }, delay);
  }
}
