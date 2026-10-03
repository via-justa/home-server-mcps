import { ErrorCodes, PluginError } from './errors.js';

/**
 * Base URL handling for plugin connections. An admin enters the upstream's base URL; the plugin
 * appends its API path. Only the schemes given are accepted, and credentials in the URL are dropped.
 */

export interface ParsedBaseUrl {
  url: URL;
  /** The base URL's path without a trailing slash (`''` for the root). */
  path: string;
}

/** Parses `baseUrl`, failing with `INVALID_PARAMS` on a malformed URL or a scheme not in `schemes`. */
export function parseBaseUrl(baseUrl: string, schemes: readonly string[] = ['http:', 'https:']): ParsedBaseUrl {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new PluginError(ErrorCodes.InvalidParams, 'baseUrl is not a valid URL');
  }
  if (!schemes.includes(url.protocol))
    throw new PluginError(ErrorCodes.InvalidParams, `Unsupported URL scheme ${url.protocol}`);
  return { url, path: url.pathname.replace(/\/+$/, '') };
}

/**
 * `https://host:8123/sub/` + `/api` → `https://host:8123/sub/api`. With `websocket`, http(s) becomes
 * ws(s) (a ws/wss base URL is accepted as is). Query, fragment and credentials are dropped.
 */
export function joinApiPath(baseUrl: string, suffix: string, opts: { websocket?: boolean } = {}): string {
  const { url, path } = parseBaseUrl(baseUrl, opts.websocket ? ['http:', 'https:', 'ws:', 'wss:'] : undefined);
  let protocol = url.protocol;
  if (opts.websocket) protocol = protocol === 'https:' || protocol === 'wss:' ? 'wss:' : 'ws:';
  return `${protocol}//${url.host}${path}${suffix}`;
}
