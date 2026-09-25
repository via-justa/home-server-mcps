/** Error codes carried across the RPC boundary and surfaced to sandboxed code as `err.code`. */
export const ErrorCodes = {
  NotImplemented: 'NOT_IMPLEMENTED',
  MethodNotFound: 'METHOD_NOT_FOUND',
  InvalidParams: 'INVALID_PARAMS',
  UnknownOperation: 'UNKNOWN_OPERATION',
  TargetResolutionFailed: 'TARGET_RESOLUTION_FAILED',
  ConfigConflict: 'CONFIG_CONFLICT',
  UpstreamDenied: 'UPSTREAM_DENIED',
  UpstreamError: 'UPSTREAM_ERROR',
  Internal: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** Throw from a handler to return a structured error to core instead of a generic INTERNAL. */
export class PluginError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'PluginError';
  }
}
