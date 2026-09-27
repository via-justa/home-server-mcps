import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aad, DecryptionError, loadMasterKey, MASTER_KEY_FILENAME, SecretBox } from '../src/crypto/index.js';

const box = SecretBox.fromKey(randomBytes(32));
const binding = aad('plugin_instances', 'secrets_enc', 'inst-1');

describe('SecretBox', () => {
  it('round-trips strings and JSON', () => {
    expect(box.decrypt(box.encrypt('s3cret', binding), binding).toString()).toBe('s3cret');
    expect(box.decryptJson(box.encryptJson({ apiKey: 'k' }, binding), binding)).toEqual({ apiKey: 'k' });
  });

  it('uses a fresh nonce per value', () => {
    expect(box.encrypt('same', binding).equals(box.encrypt('same', binding))).toBe(false);
  });

  it('refuses a ciphertext copied to another row', () => {
    const blob = box.encrypt('s3cret', binding);
    expect(() => box.decrypt(blob, aad('plugin_instances', 'secrets_enc', 'inst-2'))).toThrow(DecryptionError);
  });

  it('refuses tampered data and the wrong key', () => {
    const blob = box.encrypt('s3cret', binding);
    const tampered = Buffer.from(blob);
    tampered[20] = (tampered[20] ?? 0) ^ 0xff;
    expect(() => box.decrypt(tampered, binding)).toThrow(DecryptionError);
    expect(() => SecretBox.fromKey(randomBytes(32)).decrypt(blob, binding)).toThrow(DecryptionError);
    expect(() => box.decrypt(Buffer.from('short'), binding)).toThrow(DecryptionError);
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => SecretBox.fromKey(randomBytes(16))).toThrow(/32 bytes/);
  });

  it('derives distinct, stable subkeys per purpose', () => {
    expect(box.deriveKey('approval-links').equals(box.deriveKey('approval-links'))).toBe(true);
    expect(box.deriveKey('approval-links').equals(box.deriveKey('attestation'))).toBe(false);
  });
});

describe('loadMasterKey', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'synoikia-key-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('prefers MASTER_KEY from the environment', () => {
    const key = randomBytes(32);
    const r = loadMasterKey({ envKey: key.toString('base64'), dataDir: tmp() });
    expect(r.source).toBe('env');
    expect(r.key.equals(key)).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it('rejects a malformed MASTER_KEY', () => {
    expect(() => loadMasterKey({ envKey: 'dG9vIHNob3J0', dataDir: tmp() })).toThrow(/MASTER_KEY/);
  });

  it('generates a 0600 key file once, then reuses it', () => {
    const dataDir = tmp();
    const first = loadMasterKey({ dataDir });
    expect(first.source).toBe('generated');
    expect(first.warning).toMatch(/MASTER_KEY/);
    const file = path.join(dataDir, MASTER_KEY_FILENAME);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const second = loadMasterKey({ dataDir });
    expect(second.source).toBe('file');
    expect(second.key.equals(first.key)).toBe(true);
    expect(readFileSync(file, 'utf8').trim()).toBe(first.key.toString('base64'));
  });

  it('rejects a corrupted key file instead of silently replacing it', () => {
    const dataDir = tmp();
    writeFileSync(path.join(dataDir, MASTER_KEY_FILENAME), 'garbage');
    expect(() => loadMasterKey({ dataDir })).toThrow(/32 bytes/);
  });
});
