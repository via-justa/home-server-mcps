import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/** Minisign-format keys and signatures made with Node's Ed25519, for the repository tests. */
export function testKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = randomBytes(8);
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  return {
    publicKey: Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64'),
    sign: (data: Buffer, comment = 'test') => minisign(privateKey, keyId, data, comment),
  };
}

function minisign(privateKey: KeyObject, keyId: Buffer, data: Buffer, comment: string) {
  const digest = createHash('blake2b512').update(data).digest();
  const sig = sign(null, digest, privateKey);
  const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey);
  return [
    'untrusted comment: signature from test key',
    Buffer.concat([Buffer.from('ED'), keyId, sig]).toString('base64'),
    `trusted comment: ${comment}`,
    global.toString('base64'),
    '',
  ].join('\n');
}
