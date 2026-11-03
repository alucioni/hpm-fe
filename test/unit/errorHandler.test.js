// Los rechazos de AFIP (<Errors>) no deben salir como HTTP 500: HPM reintenta ante 5xx y
// los muestra como "Error de red / timeout".
const { test } = require('node:test');
const assert = require('node:assert');
const errorHandler = require('../../src/middleware/errorHandler');

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function correr(err) {
  const res = fakeRes();
  await errorHandler(err, { originalUrl: '/api/v1/factura/emitir' }, res, () => {});
  return res;
}

test('rechazo AFIP (11002 punto de venta no habilitado) → 422 con codigo_afip', async () => {
  const err = new Error('[11002] El punto de venta no se encuentra habilitado');
  err.codigo_afip = 11002;
  const res = await correr(err);
  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(res.body.codigo_afip, 11002);
  assert.strictEqual(res.body.ok, false);
});

test('error interno de AFIP (5xx) → 502 para que HPM reintente', async () => {
  const err = new Error('Error interno de aplicación');
  err.codigo_afip = 500;
  assert.strictEqual((await correr(err)).statusCode, 502);
});

test('err.status explícito se respeta', async () => {
  const err = new Error('no encontrada');
  err.status = 404;
  err.codigo_afip = 600;
  assert.strictEqual((await correr(err)).statusCode, 404);
});

test('error sin codigo_afip → 500', async () => {
  assert.strictEqual((await correr(new Error('boom'))).statusCode, 500);
});
