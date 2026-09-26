import { describe, expect, it } from 'vitest';
import { createInstanceRedactor, GLOBAL_SENSITIVE_KEYS } from '../src/gate/redact.js';
import { BindingError, runInSandbox } from '../src/sandbox/index.js';
import type { Binding } from '../src/sandbox/index.js';

const echo: Binding = async (args) => ({ echoed: args });
const run = (code: string, bindings: Record<string, Record<string, Binding>> = { t: { call: echo } }, limits = {}) =>
  runInSandbox({ code, bindings, limits });

describe('runInSandbox', () => {
  it('runs async code against bindings and returns JSON values', async () => {
    const r = await run(
      `const a = await t.call('x', { n: 1 }); console.log('hi', { n: 2 }); return { a, sum: 1 + 2 };`,
    );
    expect(r).toEqual({
      ok: true,
      value: { a: { echoed: ['x', { n: 1 }] }, sum: 3 },
      truncated: false,
      logs: ['hi {"n":2}'],
    });
  });

  it('returns null for undefined results', async () => {
    await expect(run('const x = 1;')).resolves.toMatchObject({ ok: true, value: null });
  });

  it('exposes no Node or network APIs, and no host references', async () => {
    // `import.meta` is a syntax error in a script.
    await expect(run(`return typeof import.meta`)).resolves.toMatchObject({
      ok: false,
      error: { code: 'SYNTAX_ERROR' },
    });
    const r = await run(
      `return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof __hsm, typeof __hsm_call, typeof __hsm_log, typeof call, typeof log, typeof bind].join(',')`,
    );
    expect(r).toMatchObject({ ok: true, value: Array(10).fill('undefined').join(',') });
    // Nothing on the global object is a host reference either.
    const globals = await run(
      `return Object.getOwnPropertyNames(globalThis).filter((k) => { const v = globalThis[k]; return v && typeof v === 'object' && typeof v.applySync === 'function'; });`,
    );
    expect(globals).toMatchObject({ ok: true, value: [] });
  });

  it('cannot reach the host through binding functions or the constructor chain', async () => {
    const r = await run(`
      const probes = [
        () => t.call.constructor('return typeof process')(),
        () => t.call.constructor.constructor('return typeof require')(),
        () => Object.getPrototypeOf(async () => {}).constructor('return typeof globalThis.process')(),
        () => (function () { return this; })().process,
        () => typeof t.call.apply === 'function' && t.call.apply(null, []) && 'no-host-apply',
      ];
      const out = [];
      for (const p of probes) {
        try { out.push(String(await p())); } catch (e) { out.push('threw'); }
      }
      return out;
    `);
    expect(r).toMatchObject({ ok: true, value: ['undefined', 'undefined', 'undefined', 'undefined', 'no-host-apply'] });
  });

  it('keeps binding namespaces frozen', async () => {
    const r = await run(
      `'use strict'; try { t.call = () => 'pwned'; } catch (e) { return 'frozen'; } return 'mutable';`,
    );
    expect(r).toMatchObject({ ok: true, value: 'frozen' });
  });

  it('surfaces binding errors as catchable Errors with a code', async () => {
    const bindings = {
      t: {
        call: async () => {
          throw new BindingError('OPERATION_DISABLED', 'app.upgrade is read-only here');
        },
        crash: async () => {
          throw new Error('secret internal detail');
        },
      },
    };
    const caught = await run(
      `try { await t.call(); } catch (e) { return [e instanceof Error, e.code, e.message]; }`,
      bindings,
    );
    expect(caught).toMatchObject({ ok: true, value: [true, 'OPERATION_DISABLED', 'app.upgrade is read-only here'] });

    const uncaught = await run(`await t.call();`, bindings);
    expect(uncaught).toMatchObject({ ok: false, error: { code: 'OPERATION_DISABLED' } });

    const internal = await run(`await t.crash();`, bindings);
    expect(internal).toMatchObject({ ok: false, error: { code: 'INTERNAL', message: 'Internal error in binding' } });
  });

  it('reports thrown user errors and syntax errors', async () => {
    await expect(run(`throw new Error('nope')`)).resolves.toMatchObject({
      ok: false,
      error: { code: 'CODE_ERROR', message: 'nope' },
    });
    await expect(run(`return (`)).resolves.toMatchObject({ ok: false, error: { code: 'SYNTAX_ERROR' } });
  });

  it('kills synchronous infinite loops', async () => {
    const r = await run('while (true) {}', undefined, { timeoutMs: 100 });
    expect(r).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
  });

  it('kills asynchronous busy loops', async () => {
    const r = await run('for (;;) { await t.call(); }', undefined, { timeoutMs: 150 });
    expect(r).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
  });

  it('enforces the memory limit', async () => {
    const r = await run('const a = []; for (;;) a.push(new Array(1e6).fill(1));', undefined, {
      memoryMb: 16,
      timeoutMs: 5000,
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'MEMORY_LIMIT' } });
  });

  it('excludes paused binding time (human approval) from the budget', async () => {
    const slowApproval: Binding = async (_args, budget) => {
      budget.pause();
      await new Promise((r) => setTimeout(r, 300));
      budget.resume();
      return 'approved';
    };
    const r = await run(`return await t.call();`, { t: { call: slowApproval } }, { timeoutMs: 150 });
    expect(r).toMatchObject({ ok: true, value: 'approved' });

    const unpaused: Binding = async () => new Promise((r) => setTimeout(() => r('late'), 300));
    const r2 = await run(`return await t.call();`, { t: { call: unpaused } }, { timeoutMs: 150 });
    expect(r2).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
  });

  it('truncates oversized results and caps logs', async () => {
    const r = await run(
      `for (let i = 0; i < 100; i++) console.log('x'.repeat(100)); return 'y'.repeat(5000);`,
      undefined,
      {
        maxResultBytes: 1000,
        maxLogBytes: 250,
      },
    );
    expect(r).toMatchObject({ ok: true, truncated: true, value: { truncated: true, bytes: 5002 } });
    expect((r as { logs: string[] }).logs.join('').length).toBe(250);
  });

  it('isolates runs from each other', async () => {
    await run('globalThis.leak = 42;');
    await expect(run('return typeof leak')).resolves.toMatchObject({ ok: true, value: 'undefined' });
  });

  it('only offers the bindings it was given, as own properties', async () => {
    const r = await run(`return Object.keys(t);`);
    expect(r).toMatchObject({ ok: true, value: ['call'] });
    // Namespaces are frozen plain objects: nothing inherited is callable as a binding.
    const inherited = await run(`return [typeof t.constructor, typeof t.hasOwnProperty, typeof t.__proto__.call];`);
    expect(inherited).toMatchObject({ ok: true, value: ['function', 'function', 'undefined'] });
    // Reserved and non-identifier names never become namespaces or functions.
    const odd = await runInSandbox({
      code: `return [typeof console.call, typeof globalThis['bad-name']];`,
      bindings: { console: { call: echo }, 'bad-name': { call: echo } },
    });
    expect(odd).toMatchObject({ ok: true, value: ['undefined', 'undefined'] });
  });
});

describe('redaction of everything leaving the sandbox', () => {
  const SECRET = 'sk-live-0123456789';
  const redact = createInstanceRedactor({ keyLists: [GLOBAL_SENSITIVE_KEYS], secretValues: [SECRET] });
  const leaky: Binding = async () => ({ apiKey: SECRET, note: `key is ${SECRET}` });
  const runR = (code: string, limits = {}) => runInSandbox({ code, bindings: { t: { call: leaky } }, limits, redact });

  it('redacts console.log arguments before they are turned into text', async () => {
    const r = await runR(`
      const v = await t.call();
      console.log(v);
      console.log(JSON.stringify(v));
      console.log('plain', { password: 'pw' }, v.apiKey);
      return null;`);
    expect(r.logs).toEqual([
      '{"apiKey":"[REDACTED]","note":"key is [REDACTED]"}',
      '{"apiKey":"[REDACTED]","note":"key is [REDACTED]"}',
      'plain {"password":"[REDACTED]"} [REDACTED]',
    ]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('redacts an oversized result before cutting its preview', async () => {
    const r = await runR(`const v = await t.call(); return { pad: 'x'.repeat(2000), raw: JSON.stringify(v) };`, {
      maxResultBytes: 500,
    });
    expect(r).toMatchObject({ ok: true, truncated: true });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('redacts derived values and error messages', async () => {
    const derived = await runR(`const v = await t.call(); return [v.apiKey.split('').join('')];`);
    expect(derived).toMatchObject({ ok: true, value: ['[REDACTED]'] });
    const thrown = await runR(`const v = await t.call(); throw new Error('boom ' + v.apiKey);`);
    expect(thrown).toMatchObject({ ok: false, error: { message: 'boom [REDACTED]' } });
  });

  it("keeps the error code when a plugin's sensitive keys include `code`, and still scrubs secret values", async () => {
    // HA lists `code` (lock and alarm codes) as sensitive; that must not hide OPERATION_DISABLED & co.
    const byCode = createInstanceRedactor({ keyLists: [GLOBAL_SENSITIVE_KEYS, ['code']], secretValues: [SECRET] });
    const denied: Binding = async () => {
      throw new BindingError('OPERATION_DISABLED', 'light.turn_on is not enabled');
    };
    const r = await runInSandbox({
      code: 'return await t.call();',
      bindings: { t: { call: denied } },
      limits: {},
      redact: byCode,
    });
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_DISABLED', message: 'light.turn_on is not enabled' },
    });
    const thrown = await runInSandbox({
      code: `throw Object.assign(new Error('x'), { code: '${SECRET}' });`,
      bindings: {},
      limits: {},
      redact: byCode,
    });
    expect(JSON.stringify(thrown)).not.toContain(SECRET);
  });
});
