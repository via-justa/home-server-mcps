// Self-contained test plugin: speaks the JSON-RPC-over-IPC contract without importing the SDK,
// because under the permission model it may only read its own directory.
import fs from 'node:fs';

let config = {};
let secrets = {};
const reply = (id, result) => process.send({ jsonrpc: '2.0', id, result: result ?? null });
const fail = (id, code, message) => process.send({ jsonrpc: '2.0', id, error: { code, message } });

const handlers = {
  init(id, params) {
    config = params.config;
    secrets = params.secrets;
    if (config.mode === 'crash-init') process.exit(3);
    if (config.mode === 'fail-init') return fail(id, 'UPSTREAM_ERROR', 'cannot reach upstream');
    if (config.mode === 'hang-init') return;
    reply(id);
  },
  testConnection: (id) => reply(id, { ok: true, upstreamVersion: '1.0' }),
  getUpstreamVersion: (id) => reply(id, '1.0'),
  syncCatalog(id) {
    if (config.mode === 'bad-output') return reply(id, { upstreamVersion: '1.0', operations: 'nope' });
    reply(id, {
      upstreamVersion: '1.0',
      operations: [
        { key: 'echo.query', kind: 'method', group: 'echo', classification: 'read', classificationReason: 'fixture' },
      ],
    });
  },
  invoke(id, { params }) {
    const tryFs = (fn) => {
      try {
        fn();
        return 'ok';
      } catch (e) {
        return e.code;
      }
    };
    switch (params.action) {
      case 'env':
        return reply(id, Object.keys(process.env).sort());
      case 'secrets':
        return reply(id, Object.keys(secrets));
      case 'read-own':
        return reply(
          id,
          tryFs(() => fs.readFileSync(new URL('./manifest.json', import.meta.url))),
        );
      case 'read':
        return reply(
          id,
          tryFs(() => fs.readFileSync(params.path)),
        );
      case 'write':
        return reply(
          id,
          tryFs(() => fs.writeFileSync(new URL('./written.txt', import.meta.url), 'x')),
        );
      case 'crash':
        return process.exit(1);
      case 'hang':
        return;
      default:
        return reply(id, params);
    }
  },
  shutdown(id) {
    reply(id);
    setImmediate(() => process.exit(0));
  },
};

process.on('message', (msg) => {
  const handler = handlers[msg.method];
  if (!handler) return fail(msg.id, 'METHOD_NOT_FOUND', msg.method);
  handler(msg.id, msg.params);
});
