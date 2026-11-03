// Regresión: AFIP producción devuelve HTTP 500 si el header SOAPAction no coincide
// con el método. Cada función de wsfev1 debe pasar `NS + <método>` a callSoap.

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

const soapMod = require('../../src/utils/soap');
const wsaaMod = require('../../src/services/wsaa');

const NS = 'http://ar.gov.afip.dif.FEV1/';
const acciones = [];

// Mock ANTES de requerir wsfev1 (que destructura callSoap al cargar).
mock.method(soapMod, 'callSoap', async (url, action) => {
  acciones.push(action);
  const metodo = action.split('/').pop();
  if (metodo === 'FECompUltimoAutorizado') {
    return '<Envelope><Body><FECompUltimoAutorizadoResponse><FECompUltimoAutorizadoResult><CbteNro>10</CbteNro></FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse></Body></Envelope>';
  }
  return '<Envelope><Body/></Envelope>';
});
mock.method(wsaaMod, 'obtenerLoginTicketResponse', async () => ({ token: 't', sign: 's' }));

const wsfev1 = require('../../src/services/wsfev1');
const empresa = { id: 1, cuit: '20219547006' };

async function accionDe(fn) {
  acciones.length = 0;
  await fn().catch(() => {}); // el parseo de la respuesta trucha puede tirar; sólo miramos la acción
  return acciones;
}

test('FEDummy → SOAPAction FEDummy', async () => {
  assert.deepEqual(await accionDe(() => wsfev1.FEDummy()), [NS + 'FEDummy']);
});

test('FECompUltimoAutorizado → SOAPAction FECompUltimoAutorizado', async () => {
  assert.deepEqual(await accionDe(() => wsfev1.FECompUltimoAutorizado(empresa, 2, 6)), [NS + 'FECompUltimoAutorizado']);
});

test('FECAESolicitar → SOAPAction FECAESolicitar', async () => {
  const a = await accionDe(() => wsfev1.FECAESolicitar(empresa, { punto_vta: 2, tipo_cbte: 11, iva: [], tributos: [], concepto: 1, moneda: 'PES', moneda_cotizacion: 1, imp_total: 1, imp_neto: 1 }));
  assert.ok(a.includes(NS + 'FECAESolicitar'), a.join());
});

test('FECompConsultar → SOAPAction FECompConsultar', async () => {
  assert.deepEqual(await accionDe(() => wsfev1.FECompConsultar(empresa, 2, 11, 1)), [NS + 'FECompConsultar']);
});

test('FEParamGet usa el nombre de método recibido', async () => {
  assert.deepEqual(await accionDe(() => wsfev1.FEParamGet(empresa, 'FEParamGetTiposCbte', 'CbteTipo')), [NS + 'FEParamGetTiposCbte']);
});

test('FEParamGetPtosVenta → SOAPAction FEParamGetPtosVenta', async () => {
  assert.deepEqual(await accionDe(() => wsfev1.FEParamGetPtosVenta(empresa)), [NS + 'FEParamGetPtosVenta']);
});

test('FECotizacionMoneda → SOAPAction FEParamGetCotizacion', async () => {
  assert.deepEqual(await accionDe(() => wsfev1.FECotizacionMoneda(empresa, 'DOL')), [NS + 'FEParamGetCotizacion']);
});
