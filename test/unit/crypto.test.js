const { test } = require('node:test');
const assert = require('node:assert/strict');
const { config } = require('../helpers');

const hasKey = !!config.p12EncryptionKey;
const { encryptPassword, decryptPassword } = require('../../src/services/crypto');

test('encryptPassword/decryptPassword: round-trip', { skip: hasKey ? false : 'P12_ENCRYPTION_KEY ausente en .env' }, () => {
  const plain = 'clave-secreta-del-p12-áéí-#$%';
  const enc = encryptPassword(plain);
  assert.notEqual(enc, plain);
  assert.equal(decryptPassword(enc), plain);
});

test('encryptPassword: formato iv:tag:data (hex)', { skip: hasKey ? false : 'sin key' }, () => {
  const enc = encryptPassword('x');
  const parts = enc.split(':');
  assert.equal(parts.length, 3);
  assert.match(parts[0], /^[0-9a-f]{24}$/, 'IV de 12 bytes');
  assert.match(parts[1], /^[0-9a-f]{32}$/, 'tag GCM de 16 bytes');
  assert.match(parts[2], /^[0-9a-f]*$/);
});

test('encryptPassword: IV aleatorio por llamada → ciphertext distinto', { skip: hasKey ? false : 'sin key' }, () => {
  const a = encryptPassword('mismo-valor');
  const b = encryptPassword('mismo-valor');
  assert.notEqual(a, b);
  assert.equal(decryptPassword(a), 'mismo-valor');
  assert.equal(decryptPassword(b), 'mismo-valor');
});

test('decryptPassword: tag manipulado lanza (AES-GCM autenticado)', { skip: hasKey ? false : 'sin key' }, () => {
  const [iv, tag, data] = encryptPassword('secreto').split(':');
  const tagRoto = (tag.slice(0, -2) + (tag.endsWith('00') ? '11' : '00'));
  assert.throws(() => decryptPassword([iv, tagRoto, data].join(':')));
});

test('decryptPassword: ciphertext manipulado lanza', { skip: hasKey ? false : 'sin key' }, () => {
  const [iv, tag, data] = encryptPassword('secreto').split(':');
  const dataRoto = (data.slice(0, -2) + (data.endsWith('00') ? '11' : '00'));
  assert.throws(() => decryptPassword([iv, tag, dataRoto].join(':')));
});
