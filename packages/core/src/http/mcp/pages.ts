import type { Context } from 'hono';
import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';

/**
 * The few server-rendered pages on the public MCP port (design §2.1): sign-in, TOTP, OAuth consent,
 * approval decisions and errors. Every interpolated value is HTML-escaped by `html`. No scripts.
 */

type Body = HtmlEscapedString | Promise<HtmlEscapedString>;

const STYLE = `
:root { --bg:#f7f7f5; --surface:#fff; --text:#1c1e21; --muted:#6b6963; --border:#e5e3de; --accent:#2563eb; --danger:#dc2626; }
@media (prefers-color-scheme: dark) { :root { --bg:#141517; --surface:#1f2124; --text:#ececea; --muted:#a3a19a; --border:#33353a; } }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg); color:var(--text);
  font:14px/1.45 -apple-system, "Segoe UI", system-ui, sans-serif; padding:16px; }
main { width:100%; max-width:440px; background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:24px; }
h1 { font-size:18px; margin:0 0 4px; } p.sub { margin:0 0 18px; color:var(--muted); }
label { display:block; font-size:12px; font-weight:600; color:var(--muted); margin:12px 0 5px; }
input[type=text], input[type=password] { width:100%; padding:9px 11px; border:1px solid var(--border); border-radius:7px; font:inherit;
  background:transparent; color:inherit; }
.row { display:flex; gap:8px; margin-top:18px; } .row > * { flex:1; }
button, a.btn { display:inline-block; text-align:center; padding:9px 14px; border-radius:7px; border:1px solid var(--border); background:var(--surface);
  color:inherit; font:inherit; font-weight:600; cursor:pointer; text-decoration:none; }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; } button.danger { color:var(--danger); }
.error { color:var(--danger); margin:12px 0 0; } .muted { color:var(--muted); font-size:12px; }
ul.endpoints { list-style:none; padding:0; margin:8px 0 0; } ul.endpoints li { padding:8px 0; border-top:1px solid var(--border); }
code, pre { font-family: ui-monospace, monospace; font-size:12px; } pre { white-space:pre-wrap; word-break:break-word; background:var(--bg);
  border:1px solid var(--border); border-radius:7px; padding:10px; max-height:260px; overflow:auto; }
.badge { font-size:11px; font-weight:700; padding:2px 7px; border-radius:999px; background:#fee2e2; color:#991b1b; }
hr { border:none; border-top:1px solid var(--border); margin:18px 0; }
`;

export function page(c: Context, title: string, body: Body, status: 200 | 400 | 401 | 403 | 404 | 429 = 200) {
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'",
  );
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
  return c.html(
    html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>${title}</title>
          <style>
            ${raw(STYLE)}
          </style>
        </head>
        <body>
          <main>${body}</main>
        </body>
      </html>`,
    status,
  );
}

export function errorPage(c: Context, title: string, message: string, status: 200 | 400 | 403 | 404 = 400) {
  return page(
    c,
    title,
    html`<h1>${title}</h1>
      <p class="sub">${message}</p>`,
    status,
  );
}

export interface LoginView {
  purpose: string;
  continueTo: string;
  csrf: string;
  error?: string;
  localLogin: boolean;
  oidc?: { label: string };
}

export function loginPage(c: Context, v: LoginView, status: 200 | 401 | 429 = 200) {
  return page(
    c,
    'Sign in',
    html`<h1>Sign in</h1>
      <p class="sub">${v.purpose}</p>
      ${
        v.localLogin
          ? html`<form method="post" action="/oauth/login">
              <input type="hidden" name="csrf" value="${v.csrf}" />
              <input type="hidden" name="continue" value="${v.continueTo}" />
              <label for="u">Username</label
              ><input id="u" type="text" name="username" autocomplete="username" autofocus required />
              <label for="p">Password</label
              ><input id="p" type="password" name="password" autocomplete="current-password" required />
              <div class="row"><button class="primary" type="submit">Sign in</button></div>
            </form>`
          : ''
      }
      ${
        v.oidc
          ? html`${v.localLogin ? html`<hr />` : ''}
              <a class="btn" style="width:100%" href="/oauth/login/oidc?continue=${encodeURIComponent(v.continueTo)}"
                >Sign in with ${v.oidc.label}</a
              >`
          : ''
      }
      ${v.error ? html`<p class="error" role="alert">${v.error}</p>` : ''}`,
    status,
  );
}

export function totpPage(
  c: Context,
  v: { mfa: string; continueTo: string; csrf: string; error?: string },
  status: 200 | 401 = 200,
) {
  return page(
    c,
    'Two-factor code',
    html`<h1>Two-factor code</h1>
      <p class="sub">Enter the code from your authenticator app, or a recovery code.</p>
      <form method="post" action="/oauth/login/totp">
        <input type="hidden" name="csrf" value="${v.csrf}" />
        <input type="hidden" name="mfa" value="${v.mfa}" />
        <input type="hidden" name="continue" value="${v.continueTo}" />
        <label for="code">Code</label
        ><input id="code" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" autofocus required />
        <div class="row"><button class="primary" type="submit">Continue</button></div>
      </form>
      ${v.error ? html`<p class="error" role="alert">${v.error}</p>` : ''}`,
    status,
  );
}

export interface ConsentView {
  clientName: string;
  redirectHost: string;
  username: string;
  endpoints: { resource: string; slug: string; name: string; checked: boolean }[];
  formToken: string;
  error?: string;
}

export function consentPage(c: Context, v: ConsentView) {
  return page(
    c,
    'Authorize access',
    html`<h1>Authorize ${v.clientName}</h1>
      <p class="sub">
        Signed in as <strong>${v.username}</strong>. After you approve, you'll be sent to
        <code>${v.redirectHost}</code>.
      </p>
      <form method="post" action="/oauth/consent">
        <input type="hidden" name="form" value="${v.formToken}" />
        <label>Endpoints this client may use</label>
        <ul class="endpoints">
          ${v.endpoints.map(
            (e) =>
              html`<li>
                <label style="display:flex;gap:8px;align-items:center;margin:0;color:inherit;font-weight:500">
                  <input type="checkbox" name="resource" value="${e.resource}" ${e.checked ? 'checked' : ''} />
                  <span><code>/${e.slug}</code> · ${e.name}</span>
                </label>
              </li>`,
          )}
        </ul>
        <p class="muted">
          Tools still go through the endpoint's access levels and approval rules. You can revoke this later under
          Clients & Tokens.
        </p>
        ${v.error ? html`<p class="error" role="alert">${v.error}</p>` : ''}
        <div class="row">
          <button class="danger" type="submit" name="decision" value="deny">Deny</button>
          <button class="primary" type="submit" name="decision" value="approve">Approve</button>
        </div>
      </form>`,
  );
}

export interface ApprovalView {
  token: string;
  csrf: string;
  username: string;
  slug: string;
  instanceName: string;
  operationKey: string;
  locked: boolean;
  summary: string;
  params: unknown;
  targets: unknown;
  diff: unknown;
  expiresAt: Date;
  confirmLiteral: string | null;
  /** The button the notification link pointed at; only highlights it, never decides. */
  intent: 'approve' | 'deny' | 'view';
  status: string;
  error?: string;
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

export function approvalPage(c: Context, v: ApprovalView, status: 200 | 400 = 200) {
  const open = v.status === 'pending';
  return page(
    c,
    'Approval request',
    html`<h1>${v.operationKey} ${v.locked ? html`<span class="badge">locked</span>` : ''}</h1>
      <p class="sub"><code>/${v.slug}</code> · ${v.instanceName}</p>
      <p>${v.summary}</p>
      ${
        v.targets != null
          ? html`<label>Targets</label>
              <pre>${pretty(v.targets)}</pre>`
          : ''
      }
      ${
        v.diff != null
          ? html`<label>Changes</label>
              <pre>${pretty(v.diff)}</pre>`
          : ''
      }
      <label>Parameters (secrets redacted)</label>
      <pre>${pretty(v.params ?? {})}</pre>
      ${
        open
          ? html`<p class="muted">Signed in as <strong>${v.username}</strong> · expires ${v.expiresAt.toISOString()}</p>
              <form method="post" action="/a/${v.token}">
                <input type="hidden" name="csrf" value="${v.csrf}" />
                ${
                  v.confirmLiteral
                    ? html`<label for="confirm">Type <code>${v.confirmLiteral}</code> to approve</label
                        ><input id="confirm" type="text" name="confirm" autocomplete="off" />`
                    : ''
                }
                ${v.error ? html`<p class="error" role="alert">${v.error}</p>` : ''}
                <div class="row">
                  <button
                    class="${v.intent === 'deny' ? 'primary' : 'danger'}"
                    type="submit"
                    name="decision"
                    value="deny"
                  >
                    Deny
                  </button>
                  <button class="${v.intent === 'deny' ? '' : 'primary'}" type="submit" name="decision" value="approve">
                    Approve
                  </button>
                </div>
              </form>`
          : html`<p class="error" role="status">This request is ${v.status.replace('_', ' ')}.</p>`
      }`,
    status,
  );
}
