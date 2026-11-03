// Test end-to-end del flujo real: app + MySQL + AFIP homologación.
//
// NO corre por defecto. Requiere:
//   - RUN_E2E=1 en el entorno
//   - MySQL accesible con la empresa emisora cargada y ACTIVA (activo=1) y su .p12 válido
//   - .env apuntando a homologación (wsaahomo / wswhomo)
//
// Consume numeración de comprobantes en homologación (esperado).
//
// PowerShell:  $env:RUN_E2E=1; npm run test:e2e
// bash:        RUN_E2E=1 npm run test:e2e

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { db, dbUp, startApp, stopApp, closeDb, req, AUTH } = require('../helpers.js');

const CUIT = process.env.E2E_CUIT || '30714794295';
const PTO_VTA = Number(process.env.E2E_PTO_VTA || 1);
const TIPO_CBTE = Number(process.env.E2E_TIPO_CBTE || 6);   // 6 = Factura B
const TIPO_DOC = Number(process.env.E2E_TIPO_DOC || 99);    // 99 = consumidor final
const NRO_DOC = Number(process.env.E2E_NRO_DOC || 0);
const COND_IVA = Number(process.env.E2E_COND_IVA || 5);     // 5 = consumidor final

function motivoSkip() {
  if (process.env.RUN_E2E !== '1') return 'RUN_E2E != 1 (test e2e desactivado)';
  return null;
}

let skip = motivoSkip();
let baseUrl;
let clave;
let numeroEmitido;

before(async () => {
  if (skip) return;
  if (!(await dbUp())) { skip = 'MySQL no disponible'; return; }
  const [rows] = await db().execute('SELECT id, activo FROM empresas WHERE cuit = ?', [CUIT]);
  if (!rows.length) { skip = `empresa CUIT ${CUIT} no cargada`; return; }
  if (!rows[0].activo) { skip = `empresa CUIT ${CUIT} está inactiva (activo=0)`; return; }
  baseUrl = await startApp();
  clave = Date.now();
});

after(async () => {
  await stopApp();
  await closeDb();
});

const o = () => (skip ? { skip } : {});

const hoy = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

const facturaBody = () => ({
  cuit_emisor: CUIT,
  clave_idempotencia: clave,
  tipo_cbte: TIPO_CBTE,
  punto_vta: PTO_VTA,
  fecha_cbte: hoy(),
  tipo_doc: TIPO_DOC,
  nro_doc: NRO_DOC,
  condicion_iva_receptor_id: COND_IVA,
  concepto: 1,
  imp_total: 121,
  imp_neto: 100,
  imp_iva: 21,
  iva: [{ id: 5, base_imp: 100, importe: 21 }],
});

test('GET /api/v1/health → 200', o(), async () => {
  const { status, body } = await req(baseUrl, 'GET', '/api/v1/health', { headers: AUTH() });
  assert.equal(status, 200);
  assert.equal(body.db, 'connected');
});

test('GET /api/v1/dummy → servicio AFIP OK', o(), async () => {
  const { status, body } = await req(baseUrl, 'GET', '/api/v1/dummy', { headers: AUTH() });
  assert.equal(status, 200);
  assert.equal(body.appserver, 'OK');
  assert.equal(body.authserver, 'OK');
  assert.equal(body.dbserver, 'OK');
});

test('sin Authorization → 401', o(), async () => {
  const { status } = await req(baseUrl, 'GET', '/api/v1/dummy');
  assert.equal(status, 401);
});

test('POST /api/v1/auth/login → token + sign + expira', o(), async () => {
  const { status, body } = await req(baseUrl, 'POST', '/api/v1/auth/login', { headers: AUTH(), body: { cuit_emisor: CUIT } });
  assert.equal(status, 200);
  assert.ok(body.token && body.sign, 'token y sign presentes');
  assert.ok(body.expira, 'expira presente');
});

test('GET /factura/ultimo-comprobante → número', o(), async () => {
  const { status, body } = await req(baseUrl, 'GET', `/api/v1/factura/ultimo-comprobante?cuit_emisor=${CUIT}&pto_vta=${PTO_VTA}&tipo_cbte=${TIPO_CBTE}`, { headers: AUTH() });
  assert.equal(status, 200);
  assert.equal(typeof body.ultimo_numero, 'number');
});

test('POST /factura/emitir → CAE aprobado', o(), async () => {
  const { status, body } = await req(baseUrl, 'POST', '/api/v1/factura/emitir', { headers: AUTH(), body: facturaBody() });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.resultado, 'A', `AFIP no aprobó: ${JSON.stringify(body)}`);
  assert.match(String(body.cae), /^\d{14}$/, 'CAE de 14 dígitos');
  assert.match(String(body.vencimiento_cae), /^\d{8}$/);
  assert.equal(typeof body.numero_comprobante, 'number');
  assert.equal(body.reintento, false);
  numeroEmitido = body.numero_comprobante;
});

test('POST /factura/emitir con misma clave → reintento true, mismo CAE', o(), async () => {
  const primero = await req(baseUrl, 'POST', '/api/v1/factura/emitir', { headers: AUTH(), body: facturaBody() });
  assert.equal(primero.status, 200);
  assert.equal(primero.body.reintento, true);
  assert.equal(primero.body.numero_comprobante, numeroEmitido);
});

test('GET /factura/consultar el comprobante emitido → coincide CAE', o(), async () => {
  if (!numeroEmitido) return;
  const { status, body } = await req(baseUrl, 'GET', `/api/v1/factura/consultar?cuit_emisor=${CUIT}&tipo_cbte=${TIPO_CBTE}&pto_vta=${PTO_VTA}&nro=${numeroEmitido}`, { headers: AUTH() });
  assert.equal(status, 200);
  assert.equal(body.resultado, 'A');
  assert.match(String(body.cae), /^\d{14}$/);
});

test('POST /factura/emitir body inválido → 422', o(), async () => {
  const b = facturaBody();
  delete b.punto_vta;
  const { status } = await req(baseUrl, 'POST', '/api/v1/factura/emitir', { headers: AUTH(), body: b });
  assert.equal(status, 422);
});

test('post-condición DB: idempotencia en estado listo y log con CAE', o(), async () => {
  const [ide] = await db().execute(
    'SELECT estado, cae, numero_comprobante FROM emisiones_idempotencia WHERE clave = ?',
    [String(clave)]
  );
  assert.ok(ide.length >= 1);
  assert.equal(ide[0].estado, 'listo');
  assert.match(String(ide[0].cae), /^\d{14}$/);
});
