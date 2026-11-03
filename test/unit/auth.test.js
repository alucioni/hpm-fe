const { test } = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../../src/middleware/auth');
const { config, runMiddleware } = require('../helpers');

const KEY = config.hpmApiKey;
const skip = KEY ? false : 'HPM_API_KEY ausente en .env';

test('sin header Authorization → 401', { skip }, async () => {
  const { res } = await runMiddleware(auth, { headers: {} });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.ok, false);
});

test('esquema distinto de Bearer → 401', { skip }, async () => {
  const { res } = await runMiddleware(auth, { headers: { authorization: `Basic ${KEY}` } });
  assert.equal(res.statusCode, 401);
});

test('API key incorrecta (misma longitud) → 401', { skip }, async () => {
  const mala = 'z'.repeat(KEY.length);
  const { res } = await runMiddleware(auth, { headers: { authorization: `Bearer ${mala}` } });
  assert.equal(res.statusCode, 401);
});

test('API key incorrecta (longitud distinta) → 401 sin romper timingSafeEqual', { skip }, async () => {
  const { res } = await runMiddleware(auth, { headers: { authorization: 'Bearer corta' } });
  assert.equal(res.statusCode, 401);
});

test('API key correcta → next()', { skip }, async () => {
  let passed = false;
  await new Promise((resolve, reject) => {
    auth({ headers: { authorization: `Bearer ${KEY}` } }, { status: () => ({ json: () => reject(new Error('respondió en vez de next')) }) }, () => { passed = true; resolve(); });
  });
  assert.ok(passed);
});
