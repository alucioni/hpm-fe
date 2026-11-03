// Tests de integración: app Express real + MySQL real, con las llamadas a AFIP (wsfev1)
// mockeadas. Verifican auth, resolución de empresa, validación, idempotencia,
// concurrencia y rate limit sin tocar los web services de AFIP.
//
// Se saltan solos si MySQL no está accesible.

import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helpers = require('../helpers.js');
const { config, db, dbUp, startApp, stopApp, closeDb, req, delay, AUTH } = helpers;

const DB_OK = await dbUp();
const suiteOpts = DB_OK ? {} : { skip: 'MySQL no disponible (arrancá WAMP / mysqld)' };

const CUIT_TEST = '30000000001';
const CUIT_INEXISTENTE = '30999999999';
let empresaId;
let baseUrl;
let wsfev1;

const emitirBody = (over = {}) => ({
  cuit_emisor: CUIT_TEST,
  clave_idempotencia: 1001,
  tipo_cbte: 6,
  punto_vta: 2,
  fecha_cbte: '20260410',
  tipo_doc: 80,
  nro_doc: 30711479295,
  condicion_iva_receptor_id: 5,
  concepto: 1,
  imp_total: 121,
  imp_neto: 100,
  imp_iva: 21,
  iva: [{ id: 5, base_imp: 100, importe: 21 }],
  ...over,
});

const CAE_FAKE = '75000000000001';

before(async () => {
  if (!DB_OK) return;

  // Empresa descartable. AFIP está mockeado, así que el p12 puede ser basura.
  await db().execute('DELETE FROM empresas WHERE cuit IN (?, ?)', [CUIT_TEST, CUIT_INEXISTENTE]);
  const [r] = await db().execute(
    `INSERT INTO empresas (cuit, razon_social, p12_data, p12_password_encrypted, api_key, activo)
     VALUES (?, 'TEST INTEGRACION', ?, 'x', ?, 1)`,
    [CUIT_TEST, Buffer.from('dummy-p12'), 'test-key-' + Date.now()]
  );
  empresaId = r.insertId;

  wsfev1 = require('../../src/services/wsfev1');
  mock.method(wsfev1, 'FECompUltimoAutorizado', async () => ({ ultimo_numero: 40 }));
  mock.method(wsfev1, 'FECAESolicitar', async () => {
    await delay(60); // ventana para el test de concurrencia
    return {
      cae: CAE_FAKE,
      vencimiento_cae: '20260720',
      numero_comprobante: 41,
      resultado: 'A',
      observaciones: [],
    };
  });
  mock.method(wsfev1, 'FECompConsultar', async () => ({
    cae: CAE_FAKE,
    vencimiento_cae: '20260720',
    resultado: 'A',
    fecha_cbte: '20260410',
    imp_total: 121,
  }));

  baseUrl = await startApp();
});

after(async () => {
  mock.restoreAll();
  if (DB_OK && empresaId) {
    await db().execute('DELETE FROM empresas WHERE id = ?', [empresaId]); // CASCADE limpia hijos
  }
  await stopApp();
  await closeDb();
});

test('GET /api/v1/health → 200 db connected', suiteOpts, async () => {
  const { status, body } = await req(baseUrl, 'GET', '/api/v1/health', { headers: AUTH() });
  assert.equal(status, 200);
  assert.equal(body.db, 'connected');
});

test('GET /factura/ultimo-comprobante sin Authorization → 401', suiteOpts, async () => {
  const { status } = await req(baseUrl, 'GET', '/api/v1/factura/ultimo-comprobante?cuit_emisor=' + CUIT_TEST + '&pto_vta=2&tipo_cbte=6');
  assert.equal(status, 401);
});

test('GET /factura/ultimo-comprobante con API key inválida → 401', suiteOpts, async () => {
  const { status } = await req(baseUrl, 'GET', '/api/v1/factura/ultimo-comprobante?cuit_emisor=' + CUIT_TEST + '&pto_vta=2&tipo_cbte=6', {
    headers: { Authorization: 'Bearer no-va' },
  });
  assert.equal(status, 401);
});

test('GET /factura/ultimo-comprobante OK → 200 con ultimo_numero', suiteOpts, async () => {
  const { status, body } = await req(baseUrl, 'GET', '/api/v1/factura/ultimo-comprobante?cuit_emisor=' + CUIT_TEST + '&pto_vta=2&tipo_cbte=6', { headers: AUTH() });
  assert.equal(status, 200);
  assert.equal(body.ultimo_numero, 40);
});

test('sin cuit_emisor → 422', suiteOpts, async () => {
  const { status } = await req(baseUrl, 'GET', '/api/v1/factura/ultimo-comprobante?pto_vta=2&tipo_cbte=6', { headers: AUTH() });
  assert.equal(status, 422);
});

test('cuit_emisor no registrado → 422', suiteOpts, async () => {
  const { status, body } = await req(baseUrl, 'GET', '/api/v1/factura/ultimo-comprobante?cuit_emisor=' + CUIT_INEXISTENTE + '&pto_vta=2&tipo_cbte=6', { headers: AUTH() });
  assert.equal(status, 422);
  assert.match(body.error, /no registrado o inactivo/i);
});

test('POST /factura/emitir válido → 200 A, reintento false, y persiste log + idempotencia', suiteOpts, async () => {
  const { status, body } = await req(baseUrl, 'POST', '/api/v1/factura/emitir', { headers: AUTH(), body: emitirBody({ clave_idempotencia: 1001 }) });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.resultado, 'A');
  assert.equal(body.cae, CAE_FAKE);
  assert.equal(body.reintento, false);

  const [ide] = await db().execute(
    'SELECT estado, cae FROM emisiones_idempotencia WHERE empresa_id = ? AND clave = ?',
    [empresaId, '1001']
  );
  assert.equal(ide[0].estado, 'listo');
  assert.equal(ide[0].cae, CAE_FAKE);

  const [log] = await db().execute(
    'SELECT cae, resultado FROM facturas_log WHERE empresa_id = ? AND cae = ?',
    [empresaId, CAE_FAKE]
  );
  assert.ok(log.length >= 1);
  assert.equal(log[0].resultado, 'A');
});

test('POST /factura/emitir con misma clave → reintento true sin volver a llamar a AFIP', suiteOpts, async () => {
  const antes = wsfev1.FECAESolicitar.mock.callCount();
  const { status, body } = await req(baseUrl, 'POST', '/api/v1/factura/emitir', { headers: AUTH(), body: emitirBody({ clave_idempotencia: 1001 }) });
  assert.equal(status, 200);
  assert.equal(body.reintento, true);
  assert.equal(body.cae, CAE_FAKE);
  assert.equal(wsfev1.FECAESolicitar.mock.callCount(), antes, 'no debe reemitir');
});

test('POST /factura/emitir body inválido (falta fecha_cbte) → 422', suiteOpts, async () => {
  const b = emitirBody({ clave_idempotencia: 1009 });
  delete b.fecha_cbte;
  const { status } = await req(baseUrl, 'POST', '/api/v1/factura/emitir', { headers: AUTH(), body: b });
  assert.equal(status, 422);
});

test('POST /factura/emitir concurrente con misma clave nueva → una 200, otra 409', suiteOpts, async () => {
  const b = emitirBody({ clave_idempotencia: 1002 });
  const [a, c] = await Promise.all([
    req(baseUrl, 'POST', '/api/v1/factura/emitir', { headers: AUTH(), body: b }),
    req(baseUrl, 'POST', '/api/v1/factura/emitir', { headers: AUTH(), body: b }),
  ]);
  const status = [a.status, c.status].sort();
  assert.deepEqual(status, [200, 409]);
});

test('GET /factura/consultar → 200 con CAE', suiteOpts, async () => {
  const { status, body } = await req(baseUrl, 'GET', '/api/v1/factura/consultar?cuit_emisor=' + CUIT_TEST + '&tipo_cbte=6&pto_vta=2&nro=41', { headers: AUTH() });
  assert.equal(status, 200);
  assert.equal(body.cae, CAE_FAKE);
});

test('rate limit: ráfaga > RATE_LIMIT_RPS devuelve algún 429', suiteOpts, async () => {
  const n = config.rateLimitRps + 15;
  const url = '/api/v1/factura/ultimo-comprobante?cuit_emisor=' + CUIT_TEST + '&pto_vta=2&tipo_cbte=6';
  const results = await Promise.all(
    Array.from({ length: n }, () => req(baseUrl, 'GET', url, { headers: AUTH() }))
  );
  const codes = results.map((r) => r.status);
  assert.ok(codes.includes(429), `esperaba al menos un 429, obtuve: ${[...new Set(codes)]}`);
  await delay(1100); // dejar que se limpie la ventana
});
