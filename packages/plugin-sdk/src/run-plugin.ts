import { ErrorCodes, PluginError } from './errors.js';
import { RPC_METHODS, isRpcRequest } from './rpc.js';
import type { PluginHandlers, RpcNotification, RpcRequest, RpcResponse } from './rpc.js';

/**
 * Builds the request dispatcher used by `runPlugin`. Exposed separately so plugins can unit-test
 * their handlers through the exact same error mapping core will see.
 */
export function createDispatcher(handlers: PluginHandlers): (req: RpcRequest) => Promise<RpcResponse> {
  return async (req) => {
    const method = req.method as (typeof RPC_METHODS)[number];
    const handler = RPC_METHODS.includes(method) ? handlers[method] : undefined;
    if (typeof handler !== 'function') {
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: { code: ErrorCodes.MethodNotFound, message: `Method not supported: ${req.method}` },
      };
    }
    try {
      const result = await (handler as (params: unknown) => unknown).call(handlers, req.params);
      return { jsonrpc: '2.0', id: req.id, result: result ?? null };
    } catch (err) {
      if (err instanceof PluginError) {
        return { jsonrpc: '2.0', id: req.id, error: { code: err.code, message: err.message, data: err.data } };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { jsonrpc: '2.0', id: req.id, error: { code: ErrorCodes.Internal, message } };
    }
  };
}

/** Sends a notification (log line, catalogChanged) to core. No-op when not running under core. */
export function notify(notification: Omit<RpcNotification, 'jsonrpc'>): void {
  process.send?.({ jsonrpc: '2.0', ...notification });
}

/**
 * Entry point for a plugin child process. Core forks the plugin's `manifest.entry` with an IPC
 * channel; this wires incoming JSON-RPC requests to `handlers` and exits after `shutdown`.
 */
export function runPlugin(handlers: PluginHandlers): void {
  if (typeof process.send !== 'function') {
    throw new Error('runPlugin() must be started by the home-server-mcps core (no IPC channel)');
  }
  const dispatch = createDispatcher(handlers);
  process.on('message', (msg: unknown) => {
    if (!isRpcRequest(msg)) return;
    void dispatch(msg).then((res) => {
      process.send?.(res);
      if (msg.method === 'shutdown') process.exit(0);
    });
  });
  process.on('disconnect', () => process.exit(0));
}
