// EMITE COMPROBANTES FISCALES REALES contra AFIP PRODUCCIÓN.
//
// Emite una Factura B mínima ($1,21 a consumidor final) y, salvo NC=NO, su
// Nota de Crédito B asociada para anularla. Son documentos fiscales reales.
//
// Doble gate obligatorio: EMITIR_REAL=SI
//
// Uso (PowerShell):
//   $env:AFIP_URL="https://servicios1.afip.gov.ar/wsfev1/service.asmx"
//   $env:WSAA_URL="https://wsaa.afip.gov.ar/ws/services/LoginCms"
//   $env:PROD_CUIT="30xxxxxxxx9"
//   $env:PROD_PTO_VTA="3"
//   $env:EMITIR_REAL="SI"
//   $env:NC="NO"                  # opcional: NO emite la nota de crédito
//   node test/prod/prod-emitir-fcb.mjs

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { config, db, dbUp, startApp, stopApp, closeDb, req, AUTH } = require('../helpers.js');

const CUIT = process.env.PROD_CUIT;
const PTO_VTA = Number(process.env.PROD_PTO_VTA || 1);
const COND_IVA = Number(process.env.PROD_COND_IVA || 5); // 5 = consumidor final
const HACER_NC = (process.env.NC || 'SI').toUpperCase() !== 'NO';

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
console.log(`\n== EMISIÓN REAL — PRODUCCIÓN — CUIT ${CUIT}, PV ${PTO_VTA} ==\n`);

async function emitir(nombre, body) {
  const { status, body: r } = await req(base, 'POST', '/api/v1/factura/emitir', { headers: AUTH(), body });
  console.log(`${nombre}: HTTP ${status}\n${JSON.stringify(r, null, 2)}\n`);
  if (status !== 200 || r.resultado !== 'A' || !r.cae) {
    throw new Error(`${nombre} no aprobada`);
  }
  return r;
}

try {
  // 1. Factura B $1,21
  const fc = await emitir('Factura B', {
    cuit_emisor: CUIT,
    clave_idempotencia: Date.now(),
    tipo_cbte: 6,
    punto_vta: PTO_VTA,
    fecha_cbte: hoy,
    tipo_doc: 99,
    nro_doc: 0,
    condicion_iva_receptor_id: COND_IVA,
    concepto: 1,
    imp_total: 1.21,
    imp_neto: 1.0,
    imp_iva: 0.21,
    iva: [{ id: 5, base_imp: 1.0, importe: 0.21 }],
  });
  console.log(`>> Factura B autorizada: N° ${fc.numero_comprobante}, CAE ${fc.cae}, vto ${fc.vencimiento_cae}\n`);

  // 2. Nota de Crédito B asociada (anula la factura)
  if (HACER_NC) {
    const nc = await emitir('Nota de Crédito B', {
      cuit_emisor: CUIT,
      clave_idempotencia: Date.now() + 1,
      tipo_cbte: 8,
      punto_vta: PTO_VTA,
      fecha_cbte: hoy,
      tipo_doc: 99,
      nro_doc: 0,
      condicion_iva_receptor_id: COND_IVA,
      concepto: 1,
      imp_total: 1.21,
      imp_neto: 1.0,
      imp_iva: 0.21,
      iva: [{ id: 5, base_imp: 1.0, importe: 0.21 }],
      comprobante_asociado: { tipo: 6, pto_vta: PTO_VTA, nro: fc.numero_comprobante, fecha: hoy },
    });
    console.log(`>> NC B autorizada: N° ${nc.numero_comprobante}, CAE ${nc.cae}. La factura queda anulada.\n`);
  } else {
    console.log('>> NC omitida (NC=NO). La Factura B queda VIGENTE — anulala manualmente con una NC.\n');
  }
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exitCode = 1;
} finally {
  await stopApp();
  await closeDb();
}
