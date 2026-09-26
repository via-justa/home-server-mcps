import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { ZodError } from 'zod';
import type { z } from 'zod';
import { ServiceError, ValidationError } from '../errors.js';
import { PluginTimeoutError, PluginUnavailableError } from '../plugins/process.js';

/** Helpers shared by the admin and MCP listeners. */

/**
 * The client's IP. Behind `trustProxy` proxies, X-Forwarded-For is read from the right: each trusted
 * proxy appends the address it saw, so the entry `trustProxy` places from the end is the one the
 * outermost proxy recorded. Anything further left was sent by the client and can be forged.
 */
export function clientIp(c: Context, trustProxy: number | boolean): string | undefined {
  const hops = Number(trustProxy);
  if (hops > 0) {
    const chain = (c.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const ip = chain[chain.length - hops];
    if (ip) return ip;
  }
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined; // app.request() in tests has no socket
  }
}

/** Whether the client reached us over TLS (directly, or at a trusted reverse proxy). */
export function isSecure(c: Context, trustProxy: number | boolean): boolean {
  if (new URL(c.req.url).protocol === 'https:') return true;
  return Number(trustProxy) > 0 && c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https';
}

/** The origin the client used, honoring X-Forwarded-* only when the proxy is trusted. */
export function requestOrigin(c: Context, trustProxy: number | boolean): string {
  const url = new URL(c.req.url);
  const proto = isSecure(c, trustProxy) ? 'https' : url.protocol.replace(':', '');
  const host =
    (Number(trustProxy) > 0 && c.req.header('x-forwarded-host')?.split(',')[0]?.trim()) ||
    c.req.header('host') ||
    url.host;
  return `${proto}://${host}`;
}

export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let body: unknown = {};
  const text = await c.req.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ValidationError('invalid_json', 'Request body must be JSON');
    }
  }
  return schema.parse(body);
}

/** Maps service errors onto JSON responses; anything unexpected is a 500 without internals. */
export function errorResponse(err: unknown, c: Context) {
  if (err instanceof ServiceError) {
    return c.json(
      { error: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
      err.status,
    );
  }
  if (err instanceof ZodError) {
    return c.json(
      {
        error: 'invalid_request',
        message: 'Invalid request',
        details: err.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`),
      },
      400,
    );
  }
  if (err instanceof PluginUnavailableError || err instanceof PluginTimeoutError) {
    return c.json({ error: 'plugin_unavailable', message: err.message }, 503);
  }
  console.error(err);
  return c.json({ error: 'internal', message: 'Internal error' }, 500);
}
