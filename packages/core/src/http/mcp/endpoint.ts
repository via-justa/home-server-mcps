import { randomUUID } from 'node:crypto';
import type { Manifest } from '@home-server-mcps/plugin-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { ElicitRequestFormParams } from '@modelcontextprotocol/sdk/types.js';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import type { ElicitFn } from '../../approvals/service.js';
import { authenticateMcp } from '../../auth/mcp-auth.js';
import type { McpIdentity } from '../../auth/mcp-auth.js';
import type { OAuthService } from '../../auth/oauth.js';
import type { CallerContext } from '../../gate/pipeline.js';
import { executeCode, searchCode } from '../../runtime/index.js';
import type { SandboxResult } from '../../sandbox/index.js';

/**
 * `/{slug}` Streamable HTTP endpoints (design §2.2): one McpServer + transport per MCP session,
 * bound to its instance and authenticated principal, exposing exactly `search` and `execute`.
 */

const SESSION_IDLE_MS = 30 * 60_000;
const SERVER_VERSION = '0.1.0';

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  instanceId: string;
  principal: string;
  lastSeen: number;
}

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: '2.0' as const,
  id: null,
  error: { code, message },
});

function toolText(result: SandboxResult) {
  if (!result.ok) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              error: result.error.code,
              message: result.error.message,
              ...(result.logs.length ? { logs: result.logs } : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  }
  const body = {
    result: result.value,
    ...(result.truncated ? { truncated: true } : {}),
    ...(result.logs.length ? { logs: result.logs } : {}),
  };
  return { content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }] };
}

export function describeSearch(manifest: Manifest): string {
  const ops = manifest.labels.operations.toLowerCase();
  const apis = [
    `catalog.find({ text?, group?, kind?, classification?: 'read'|'write'|'locked', includeDisabled?, limit? }) → ${ops} you can call (with includeDisabled, also the unavailable ones and why)`,
    'catalog.get(key) → one entry with its parameter schema and docs',
    'catalog.groups() → access groups with their level (none/read/write) and counts',
  ];
  if (manifest.capabilities.registry)
    apis.push(
      'registry.find({ kind?, text?, parent?, domain?, limit? }) → matching upstream objects (areas, entities, …)',
    );
  if (manifest.capabilities.attestation) {
    apis.push(
      'guides.get(key) → best-practice guide; pass its best_practice_key in the params when calling that operation',
    );
  }
  return [
    `Search the ${manifest.name} ${ops} catalog. \`code\` is the body of an async JavaScript function; return a JSON-serializable value.`,
    'Available:',
    ...apis.map((a) => `- ${a}`),
    'Use this before execute to find operation keys and parameters. It never contacts the upstream.',
  ].join('\n');
}

export function describeExecute(manifest: Manifest): string {
  const ns = manifest.binding.namespace;
  const fns = manifest.binding.functions.map((f) => `${ns}.${f}(…)`).join(', ');
  return [
    `Run code against ${manifest.name}. \`code\` is the body of an async JavaScript function; \`await\` ${fns} and return a JSON-serializable result.`,
    'Reads run immediately. Writes may pause until a human approves; denials and other refusals throw an Error with `err.code` (e.g. OPERATION_DISABLED, PERMISSION_DENIED, UPSTREAM_ERROR) that your code can catch.',
    'Calls run one at a time. There is no network, filesystem or timer access. Secrets in results are redacted.',
  ].join('\n');
}

export class McpEndpoints {
  private readonly sessions = new Map<string, Session>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly ctx: AppContext,
    private readonly oauth: OAuthService,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  get sessionCount() {
    return this.sessions.size;
  }

  private sweep() {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, s] of this.sessions) if (s.lastSeen < cutoff) void this.closeSession(id);
  }

  private async closeSession(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    await s.transport.close().catch(() => undefined);
    await s.server.close().catch(() => undefined);
  }

  async closeAll() {
    clearInterval(this.sweeper);
    await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id)));
  }

  private buildServer(instanceId: string, identity: McpIdentity): McpServer {
    const rt = () => this.ctx.instances.runtime(instanceId);
    const manifest = rt().manifest;
    const server = new McpServer(
      { name: `home-server-mcps/${rt().slug}`, version: SERVER_VERSION },
      {
        instructions: `${manifest.name} via home-server-mcps. Use search to discover operations, then execute to call them.`,
      },
    );

    const caller = (sessionId: string | undefined): CallerContext => {
      const runtime = rt();
      const elicit: ElicitFn | undefined = server.server.getClientCapabilities()?.elicitation
        ? async (req) => {
            const res = await server.server.elicitInput(
              {
                message: req.message,
                requestedSchema: req.requestedSchema as ElicitRequestFormParams['requestedSchema'],
              },
              { timeout: runtime.settings.approvalTimeoutMs },
            );
            return { action: res.action, content: res.content as { approve?: unknown; confirm?: unknown } | undefined };
          }
        : undefined;
      return { client: { kind: 'mcp_client', id: identity.label }, mcpSessionId: sessionId, elicit };
    };

    const run = async (fn: typeof searchCode, code: string, sessionId: string | undefined) => {
      try {
        await this.ctx.instances.ensureFresh(instanceId);
      } catch (err) {
        return toolText({
          ok: false,
          error: { code: 'PLUGIN_UNAVAILABLE', message: err instanceof Error ? err.message : 'Endpoint unavailable' },
          logs: [],
        });
      }
      return toolText(await fn(this.ctx.gateDeps(), rt(), caller(sessionId), code));
    };

    const input = {
      code: z
        .string()
        .min(1)
        .max(100_000)
        .describe('Body of an async JavaScript function. Use `return` for the result.'),
    };
    server.registerTool(
      'search',
      { title: `Search ${manifest.name}`, description: describeSearch(manifest), inputSchema: input },
      ({ code }, extra) => run(searchCode, code, extra.sessionId),
    );
    server.registerTool(
      'execute',
      { title: `Execute on ${manifest.name}`, description: describeExecute(manifest), inputSchema: input },
      ({ code }, extra) => run(executeCode, code, extra.sessionId),
    );
    return server;
  }

  async handle(c: Context, slug: string): Promise<Response> {
    const found = this.ctx.instances.bySlug(slug);
    if (!found) return c.json(jsonRpcError(-32001, 'Unknown MCP endpoint'), 404);
    const { instance, plugin } = found;
    if (!this.ctx.instances.isServing(instance, plugin))
      return c.json(jsonRpcError(-32002, 'This endpoint is disabled'), 503);

    const auth = await authenticateMcp(this.ctx, this.oauth, c, instance);
    if (!auth.ok) {
      if (auth.wwwAuthenticate) c.header('WWW-Authenticate', auth.wwwAuthenticate);
      return c.json({ error: auth.error, error_description: auth.message }, auth.status);
    }

    const sessionId = c.req.header('mcp-session-id');
    if (sessionId) {
      const s = this.sessions.get(sessionId);
      // A session id is only valid for the endpoint and principal that created it.
      if (!s || s.instanceId !== instance.id || s.principal !== auth.identity.principal) {
        return c.json(jsonRpcError(-32001, 'Session not found'), 404);
      }
      s.lastSeen = Date.now();
      return s.transport.handleRequest(c.req.raw);
    }

    if (c.req.method !== 'POST') return c.json(jsonRpcError(-32000, 'Missing Mcp-Session-Id'), 400);
    try {
      await this.ctx.instances.ensureFresh(instance.id, { forceVersionCheck: true });
    } catch (err) {
      return c.json(
        jsonRpcError(-32002, `Endpoint unavailable: ${err instanceof Error ? err.message : String(err)}`),
        503,
      );
    }

    const server = this.buildServer(instance.id, auth.identity);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, {
          transport,
          server,
          instanceId: instance.id,
          principal: auth.identity.principal,
          lastSeen: Date.now(),
        });
      },
      onsessionclosed: (id) => void this.closeSession(id),
    });
    await server.connect(transport);
    const response = await transport.handleRequest(c.req.raw);
    if (!transport.sessionId) {
      // Not a valid initialize request: nothing to keep.
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
    return response;
  }
}
