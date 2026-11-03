// EMITE COMPROBANTES FISCALES REALES contra AFIP PRODUCCIÓN — Factura C (monotributo).
//
// Emite una Factura C mínima ($1,21, sin IVA discriminado) y, salvo NC=NO, su
// Nota de Crédito C asociada para anularla. Son documentos fiscales reales.
//
// Doble gate obligatorio: EMITIR_REAL=SI
//
// Uso (PowerShell):
//   $env:AFIP_URL="https://servicios1.afip.gov.ar/wsfev1/service.asmx"
//   $env:WSAA_URL="https://wsaa.afip.gov.ar/ws/services/LoginCms"
//   $env:PROD_CUIT="20219547006"
//   $env:PROD_PTO_VTA="2"
//   $env:EMITIR_REAL="SI"
//   $env:NC="NO"                  # opcional: NO emite la nota de crédito
//   node test/prod/prod-emitir-fcc.mjs

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { config, db, dbUp, startApp, stopApp, closeDb, req, AUTH } = require('../helpers.js');

const CUIT = process.env.PROD_CUIT;
const PTO_VTA = Number(process.env.PROD_PTO_VTA || 1);
const COND_IVA = Number(process.env.PROD_COND_IVA || 5); // 5 = consumidor final
const HACER_NC = (process.env.NC || 'SI').toUpperCase() !== 'NO';
const IMPORTE = Number(process.env.PROD_IMPORTE || 1.21);

function abort(msg) { console.error(msg); process.exit(1); }

if (process.env.EMITIR_REAL !== 'SI') {
  abort('Bloqueado. Este script emite comprobantes fiscales reales. Seteá EMITIR_REAL=SI para continuar.');
}
if (!CUIT || !/^\d{11}$/.test(CUIT)) abort('Falta PROD_CUIT (11 dígitos).');

const esProd = /servicios1\.afip\.gov\.ar/.test(config.afip.url || '')
  && /wsaa\.afip\.gov\.ar/.test(config.afip.wsaaUrl || '');
if (!esProd) abort(`URLs no son de producción:\n  AFIP_URL=${config.afip.url}\n  WSAA_URL=${config.afip.wsaaUrl}`);

if (!(await dbUp())) abort('MySQL no disponible.');
const [rows] = await db().execute('SELECT activo FROM empresas WHERE cuit = ?', [CUIT]);
if (!rows.length) { await closeDb(); abort(`Empresa CUIT ${CUIT} no cargada.`); }
if (!rows[0].activo) { await closeDb(); abort(`Empresa CUIT ${CUIT} inactiva.`); }

const hoy = (() => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
})();

const base = await startApp();
console.log(`\n== EMISIÓN REAL — PRODUCCIÓN — Factura C — CUIT ${CUIT}, PV ${PTO_VTA}, $${IMPORTE} ==\n`);

async function emitir(nombre, body) {
  const { status, body: r } = await req(base, 'POST', '/api/v1/factura/emitir', { headers: AUTH(), body });
  console.log(`${nombre}: HTTP ${status}\n${JSON.stringify(r, null, 2)}\n`);
  if (status !== 200 || r.resultado !== 'A' || !r.cae) {
    throw new Error(`${nombre} no aprobada`);
  }
  return r;
}

// Factura C: sin IVA discriminado. imp_neto == imp_total, imp_iva 0, sin array iva.
const comun = {
  cuit_emisor: CUIT,
  punto_vta: PTO_VTA,
  fecha_cbte: hoy,
  tipo_doc: 99,
  nro_doc: 0,
  condicion_iva_receptor_id: COND_IVA,
  concepto: 1,
  imp_total: IMPORTE,
  imp_neto: IMPORTE,
  imp_iva: 0,
  iva: [],
};

try {
  const fc = await emitir('Factura C', {
    ...comun,
    clave_idempotencia: Date.now(),
    tipo_cbte: 11,
  });
  console.log(`>> Factura C autorizada: N° ${fc.numero_comprobante}, CAE ${fc.cae}, vto ${fc.vencimiento_cae}\n`);

  if (HACER_NC) {
    const nc = await emitir('Nota de Crédito C', {
      ...comun,
      clave_idempotencia: Date.now() + 1,
      tipo_cbte: 13,
      comprobante_asociado: { tipo: 11, pto_vta: PTO_VTA, nro: fc.numero_comprobante, fecha: hoy },
    });
    console.log(`>> NC C autorizada: N° ${nc.numero_comprobante}, CAE ${nc.cae}. La factura queda anulada.\n`);
  } else {
    console.log('>> NC omitida (NC=NO). La Factura C queda VIGENTE — anulala manualmente con una NC.\n');
  }
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exitCode = 1;
} finally {
  await stopApp();
  await closeDb();
}
