// Chequeos READ-ONLY contra AFIP PRODUCCIÓN. NO emite ningún comprobante.
//
// Ejercita todo el circuito productivo (firma CMS, WSAA, punto de venta, parseo SOAP)
// sin generar documentos fiscales.
//
// Requiere:
//   - MySQL levantado, con la empresa (PROD_CUIT) cargada, activa y con su .p12 de PRODUCCIÓN
//   - el server configurado a URLs de producción
//
// Uso (PowerShell):
//   $env:AFIP_URL="https://servicios1.afip.gov.ar/wsfev1/service.asmx"
//   $env:WSAA_URL="https://wsaa.afip.gov.ar/ws/services/LoginCms"
//   $env:PROD_CUIT="30xxxxxxxx9"
//   $env:PROD_PTO_VTA="3"          # opcional (default 1)
//   $env:PROD_TIPO_CBTE="6"        # opcional (default 6 = Factura B)
//   $env:PROD_NRO="123"            # opcional: si está, consulta ese comprobante
//   node test/prod/prod-smoke.mjs

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { config, db, dbUp, startApp, stopApp, closeDb, req, AUTH } = require('../helpers.js');

const CUIT = process.env.PROD_CUIT;
const PTO_VTA = Number(process.env.PROD_PTO_VTA || 1);
const TIPO_CBTE = Number(process.env.PROD_TIPO_CBTE || 6);
const NRO = process.env.PROD_NRO ? Number(process.env.PROD_NRO) : null;

function fail(msg) { console.error(`\n✗ ${msg}`); process.exitCode = 1; }
function ok(msg) { console.log(`✓ ${msg}`); }

if (!CUIT || !/^\d{11}$/.test(CUIT)) {
  console.error('Falta PROD_CUIT (11 dígitos).');
  process.exit(1);
}

const esProd = /servicios1\.afip\.gov\.ar/.test(config.afip.url || '')
  && /wsaa\.afip\.gov\.ar/.test(config.afip.wsaaUrl || '');
console.log(`AFIP_URL = ${config.afip.url}`);
console.log(`WSAA_URL = ${config.afip.wsaaUrl}`);
if (!esProd) {
  console.error('\n⚠  Las URLs NO son de producción. Seteá AFIP_URL / WSAA_URL de producción y reintentá.');
  process.exit(1);
}

if (!(await dbUp())) {
  console.error('MySQL no disponible.');
  process.exit(1);
}

const [rows] = await db().execute('SELECT id, activo FROM empresas WHERE cuit = ?', [CUIT]);
if (!rows.length) { console.error(`La empresa CUIT ${CUIT} no está cargada.`); await closeDb(); process.exit(1); }
if (!rows[0].activo) { console.error(`La empresa CUIT ${CUIT} está inactiva.`); await closeDb(); process.exit(1); }

const base = await startApp();
console.log(`\n== Smoke read-only PRODUCCIÓN — CUIT ${CUIT}, PV ${PTO_VTA}, tipo_cbte ${TIPO_CBTE} ==\n`);

try {
  // 1. Dummy
  {
    const { status, body } = await req(base, 'GET', '/api/v1/dummy', { headers: AUTH() });
    if (status === 200 && body.appserver === 'OK' && body.authserver === 'OK' && body.dbserver === 'OK') {
      ok('dummy: servicio AFIP OK');
    } else fail(`dummy: ${status} ${JSON.stringify(body)}`);
  }

  // 2. Login WSAA (prueba certificado + delegación del WS)
  {
    const { status, body } = await req(base, 'POST', '/api/v1/auth/login', { headers: AUTH(), body: { cuit_emisor: CUIT } });
    if (status === 200 && body.token && body.sign) {
      ok(`auth/login: token OK, expira ${body.expira}`);
    } else fail(`auth/login: ${status} ${JSON.stringify(body)}`);
  }

  // 3. Puntos de venta habilitados
  {
    const { status, body } = await req(base, 'GET', `/api/v1/parametros/puntos-venta?cuit_emisor=${CUIT}`, { headers: AUTH() });
    if (status === 200 && Array.isArray(body.datos)) {
      ok(`puntos-venta: ${JSON.stringify(body.datos)}`);
      if (!body.datos.some((p) => Number(p.id) === PTO_VTA)) {
        fail(`el PV ${PTO_VTA} no figura entre los habilitados`);
      }
    } else fail(`puntos-venta: ${status} ${JSON.stringify(body)}`);
  }

  // 4. Último comprobante autorizado
  {
    const { status, body } = await req(base, 'GET', `/api/v1/factura/ultimo-comprobante?cuit_emisor=${CUIT}&pto_vta=${PTO_VTA}&tipo_cbte=${TIPO_CBTE}`, { headers: AUTH() });
    if (status === 200 && typeof body.ultimo_numero === 'number') {
      ok(`ultimo-comprobante: ${body.ultimo_numero} (próximo sería ${body.ultimo_numero + 1})`);
    } else fail(`ultimo-comprobante: ${status} ${JSON.stringify(body)}`);
  }

  // 5. Consultar un comprobante existente (opcional)
  if (NRO) {
    const { status, body } = await req(base, 'GET', `/api/v1/factura/consultar?cuit_emisor=${CUIT}&tipo_cbte=${TIPO_CBTE}&pto_vta=${PTO_VTA}&nro=${NRO}`, { headers: AUTH() });
    if (status === 200 && body.cae) {
      ok(`consultar nro ${NRO}: CAE ${body.cae}, resultado ${body.resultado}, total ${body.imp_total}`);
    } else fail(`consultar nro ${NRO}: ${status} ${JSON.stringify(body)}`);
  }
} finally {
  await stopApp();
  await closeDb();
}

console.log(process.exitCode ? '\n== FALLÓ algún chequeo ==' : '\n== Todo OK — circuito de producción validado (sin emitir) ==');
