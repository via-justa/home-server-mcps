import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../src/gate/canonical.js';
import { getPointer, matches, MatchSchema } from '../src/gate/match.js';
import { createInstanceRedactor, createRedactor, GLOBAL_SENSITIVE_KEYS, REDACTED } from '../src/gate/redact.js';

describe('createRedactor', () => {
  const redact = createRedactor(GLOBAL_SENSITIVE_KEYS, ['plexToken']);

  it('redacts sensitive keys at any depth, case- and separator-insensitively', () => {
    expect(
      redact({
        name: 'share',
        API_KEY: 'k1',
        nested: [{ 'private-key': 'pem', plextoken: 'p', keep: 'me' }],
        auth: { password: 'x', user: 'u' },
      }),
    ).toEqual({
      name: 'share',
      API_KEY: REDACTED,
      nested: [{ 'private-key': REDACTED, plextoken: REDACTED, keep: 'me' }],
      auth: { password: REDACTED, user: 'u' },
    });
  });

  it('leaves empty values visible (so "no password set" is still readable) and does not mutate input', () => {
    const input = { password: '', token: null, secret: 's' };
    expect(redact(input)).toEqual({ password: '', token: null, secret: REDACTED });
    expect(input.secret).toBe('s');
  });

  it('redacts keys that contain a sensitive word, keeping flags and counts visible (review L1)', () => {
    expect(
      redact({
        db_password: 'hunter2',
        newPassword: 'n',
        smtp_pass: 's',
        authPass: 'a',
        ssh_private_key: 'pem',
        'X-Api-Key': 'k',
        Authorization: 'Bearer abc',
        headers: { cookie: 'sid=1' },
        password_set: true,
        max_tokens: 4096,
        bypass: 'on',
        passive: 'yes',
        compass: 'north',
      }),
    ).toEqual({
      db_password: REDACTED,
      newPassword: REDACTED,
      smtp_pass: REDACTED,
      authPass: REDACTED,
      ssh_private_key: REDACTED,
      'X-Api-Key': REDACTED,
      Authorization: REDACTED,
      headers: { cookie: REDACTED },
      password_set: true,
      max_tokens: 4096,
      bypass: 'on',
      passive: 'yes',
      compass: 'north',
    });
    // An exact match hides any value, numbers included.
    expect(redact({ password: 1234 })).toEqual({ password: REDACTED });
  });

  it('handles primitives and cycles', () => {
    expect(redact('plain')).toBe('plain');
    const a: Record<string, unknown> = { password: 'x' };
    a.self = a;
    expect(redact(a)).toEqual({ password: REDACTED, self: '[Circular]' });
  });
});

describe('canonicalJson', () => {
  it('is stable across key order and hashes identically', () => {
    const a = canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } });
    const b = canonicalJson({ a: { c: null, d: [3, { x: 2, y: 1 }] }, b: 1 });
    expect(a).toBe(b);
    expect(sha256Hex(a)).toBe(sha256Hex(b));
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('getPointer', () => {
  it('follows RFC 6901 pointers', () => {
    const doc = { a: { 'b/c': [10, 20], 'm~n': null } };
    expect(getPointer(doc, '/a/b~1c/1')).toBe(20);
    expect(getPointer(doc, '/a/m~0n')).toBeNull();
    expect(typeof getPointer(doc, '/a/missing')).toBe('symbol');
    expect(typeof getPointer(doc, '/a/b~1c/1/x')).toBe('symbol');
  });
});

describe('matches', () => {
  const call = (params: unknown, targets: { id: string; scopes?: Record<string, string> }[] = []) => ({
    params,
    targets: targets.map((t) => ({ kind: 'entity', name: t.id, scopes: {}, ...t })),
  });

  it('treats an empty match as "no parameters", and `any` on "" as "any parameters"', () => {
    expect(matches([], call({}))).toBe(true);
    expect(matches([], call(undefined))).toBe(true);
    expect(matches([], call({ name: 'x' }))).toBe(false);
    expect(matches([{ field: '', op: 'any' }], call({ name: 'x', deep: { a: 1 } }))).toBe(true);
  });

  it('is strict: every parameter must be covered by a condition or accepted with `any`', () => {
    const rule = [{ field: '/name', op: 'prefix', value: 'tank/media' }] as const;
    expect(matches(rule, call({ name: 'tank/media/tv' }))).toBe(true);
    expect(matches(rule, call({ name: 'tank/media/tv', quota: 1 }))).toBe(false);
    const withQuota = [...rule, { field: '/quota', op: 'any' }] as const;
    expect(matches(withQuota, call({ name: 'tank/media/tv', quota: 1 }))).toBe(true);
    expect(matches(withQuota, call({ name: 'tank/media/tv' }))).toBe(true); // `any` also allows absence
    // A condition deeper in an object only covers that key; its siblings still need one.
    const deep = [{ field: '/body/is4k', op: 'bool', value: false }] as const;
    expect(matches(deep, call({ body: { is4k: false } }))).toBe(true);
    expect(matches(deep, call({ body: { is4k: false, userId: 7 } }))).toBe(false);
    expect(matches([...deep, { field: '/body/userId', op: 'any' }], call({ body: { is4k: false, userId: 7 } }))).toBe(
      true,
    );
  });

  it('covers positional (array) params by index, and whole arrays by their own path', () => {
    const rule = [{ field: '/0/name', op: 'prefix', value: 'tank/media' }] as const;
    expect(matches(rule, call([{ name: 'tank/media/tv' }]))).toBe(true);
    expect(matches(rule, call([{ name: 'tank/media/tv', quota: 1 }]))).toBe(false);
    expect(matches(rule, call([{ name: 'tank/media/tv' }, { recursive: true }]))).toBe(false);
    expect(matches([...rule, { field: '/1', op: 'any' }], call([{ name: 'tank/media/tv' }, { a: 1 }]))).toBe(true);
    expect(matches([{ field: '/0', op: 'in', value: ['plex'] }], call(['plex']))).toBe(true);
    expect(matches([{ field: '/0', op: 'in', value: ['plex'] }], call(['plex', { force: true }]))).toBe(false);
    // An array covered at its own path is covered whole, as before.
    expect(matches([{ field: '/apps', op: 'in', value: ['a', 'b'] }], call({ apps: ['a', 'b'] }))).toBe(true);
    expect(matches([], call([]))).toBe(true);
  });

  it.each([
    ['prefix hit', { field: '/name', op: 'prefix', value: 'tank/media/' }, { name: 'tank/media/tv' }, true],
    ['prefix at a boundary', { field: '/name', op: 'prefix', value: 'tank/media' }, { name: 'tank/media/tv' }, true],
    ['prefix equal', { field: '/name', op: 'prefix', value: 'tank/media' }, { name: 'tank/media' }, true],
    [
      'prefix mid-segment',
      { field: '/name', op: 'prefix', value: 'tank/media' },
      { name: 'tank/media-private' },
      false,
    ],
    ['prefix miss', { field: '/name', op: 'prefix', value: 'tank/media/' }, { name: 'tank/other' }, false],
    ['prefix on non-string', { field: '/name', op: 'prefix', value: 'tank/' }, { name: 5 }, false],
    ['empty prefix never matches', { field: '/name', op: 'prefix', value: '' }, { name: 'x' }, false],
    ['in scalar', { field: '/app_name', op: 'in', value: ['plex', 'sonarr'] }, { app_name: 'plex' }, true],
    ['in scalar miss', { field: '/app_name', op: 'in', value: ['plex'] }, { app_name: 'nextcloud' }, false],
    ['in array: every element', { field: '/apps', op: 'in', value: ['a', 'b'] }, { apps: ['a', 'b'] }, true],
    ['in array: one outside', { field: '/apps', op: 'in', value: ['a'] }, { apps: ['a', 'x'] }, false],
    ['in empty array', { field: '/apps', op: 'in', value: ['a'] }, { apps: [] }, false],
    ['eq deep', { field: '/o', op: 'eq', value: { a: 1, b: 2 } }, { o: { b: 2, a: 1 } }, true],
    ['bool', { field: '/body/is4k', op: 'bool', value: false }, { body: { is4k: false } }, true],
    ['bool type mismatch', { field: '/body/is4k', op: 'bool', value: false }, { body: { is4k: 'false' } }, false],
    ['range inside', { field: '/t', op: 'range', value: { min: 65, max: 78 } }, { t: 70 }, true],
    ['range above', { field: '/t', op: 'range', value: { min: 65, max: 78 } }, { t: 79 }, false],
    ['range non-number', { field: '/t', op: 'range', value: { min: 65 } }, { t: '70' }, false],
    ['range without bounds', { field: '/t', op: 'range', value: {} }, { t: 70 }, false],
    ['missing field', { field: '/name', op: 'prefix', value: 'tank/' }, {}, false],
  ] as const)('%s', (_name, condition, params, expected) => {
    expect(matches([condition], call(params))).toBe(expected);
  });

  it('requires every resolved target to satisfy every target selector', () => {
    const cond = { field: '$targets' as const, areas: ['living_room'], domains: ['light'] };
    const inRoom = { id: 'light.lamp', scopes: { area: 'living_room', domain: 'light' } };
    const elsewhere = { id: 'light.porch', scopes: { area: 'exterior', domain: 'light' } };
    expect(matches([cond], call({}, [inRoom]))).toBe(true);
    expect(matches([cond], call({}, [inRoom, elsewhere]))).toBe(false);
    expect(matches([cond], call({}, []))).toBe(false);
    expect(matches([{ field: '$targets', entities: ['light.lamp'] }], call({}, [inRoom]))).toBe(true);
  });

  it('ANDs conditions', () => {
    const rule = [
      { field: '/name', op: 'prefix', value: 'tank/media/' },
      { field: '/quota', op: 'range', value: { max: 100 } },
    ] as const;
    expect(matches(rule, call({ name: 'tank/media/a', quota: 50 }))).toBe(true);
    expect(matches(rule, call({ name: 'tank/media/a', quota: 500 }))).toBe(false);
  });

  it('validates rule shapes', () => {
    expect(MatchSchema.safeParse([{ field: '/n', op: 'prefix', value: 'x' }]).success).toBe(true);
    expect(MatchSchema.safeParse([{ field: '$targets' }]).success).toBe(false);
    expect(MatchSchema.safeParse([{ field: 'name', op: 'prefix', value: 'x' }]).success).toBe(false);
    expect(MatchSchema.safeParse([{ field: '/n', op: 'regex', value: '.*' }]).success).toBe(false);
    expect(MatchSchema.safeParse([{ field: '', op: 'any' }]).success).toBe(true);
    expect(MatchSchema.safeParse([{ field: '', op: 'eq', value: 1 }]).success).toBe(false);
  });
});

describe('instance redactor', () => {
  it('scrubs the instance secret values out of any text, encoded or not, and ignores short ones', () => {
    const redact = createInstanceRedactor({ keyLists: [GLOBAL_SENSITIVE_KEYS], secretValues: ['p@ss word!', 'abc'] });
    expect(redact('login with p@ss word! failed')).toBe('login with [REDACTED] failed');
    expect(redact({ url: 'https://x/?k=p%40ss%20word!' })).toEqual({ url: 'https://x/?k=[REDACTED]' });
    expect(redact({ ['p@ss word!']: 1 })).toEqual({ [REDACTED]: 1 });
    expect(redact('abc stays')).toBe('abc stays'); // too short to scrub safely
  });
});
