import type { Hono } from 'hono';

/** Minimal browser-like client for `app.request()`: keeps cookies and echoes the CSRF token. */
export function browser(app: Pick<Hono, 'request'>, opts: { csrf?: boolean } = {}) {
  const jar = new Map<string, string>();
  const withCsrf = opts.csrf ?? true;

  async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (withCsrf && jar.has('hsm_csrf') && !('x-csrf-token' in h)) h['x-csrf-token'] = jar.get('hsm_csrf')!;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await app.request(path, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const expired = attrs.some((a) => /max-age=0\b/i.test(a.trim())) || value === '';
      if (expired) jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  }

  return {
    jar,
    req,
    get: (p: string, h?: Record<string, string>) => req('GET', p, undefined, h),
    post: (p: string, b?: unknown, h?: Record<string, string>) => req('POST', p, b ?? {}, h),
    put: (p: string, b?: unknown) => req('PUT', p, b ?? {}),
    patch: (p: string, b?: unknown) => req('PATCH', p, b ?? {}),
    del: (p: string, b?: unknown) => req('DELETE', p, b),
    /** GET /api/session first, so the CSRF cookie exists (as the SPA does on load). */
    async init() {
      await req('GET', '/api/session');
      return this;
    },
  };
}
