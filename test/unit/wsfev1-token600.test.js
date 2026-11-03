// Ante el error 600 de AFIP (ValidacionDeToken) wsfev1 debe borrar el ticket del cache,
// pedir uno nuevo a WSAA y reintentar una sola vez. Cualquier otro error no se reintenta.

const { test, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const soapMod = require('../../src/utils/soap');
const wsaaMod = require('../../src/services/wsaa');
const tokenCache = require('../../src/services/tokenCache');

let tokens;          // tickets de WSAA: el cache devuelve tokens[0] hasta que se borra
let respuestas;      // por método: función (xml) => respuesta SOAP
let llamadas;        // [método, token usado]
let borrados;

const ERR = (metodo, codigo) =>
  `<Envelope><Body><${metodo}Response><${metodo}Result><Errors><Err><Code>${codigo}</Code><Msg>error ${codigo}</Msg></Err></Errors></${metodo}Result></${metodo}Response></Body></Envelope>`;
const ULTIMO = (nro) =>
  `<Envelope><Body><FECompUltimoAutorizadoResponse><FECompUltimoAutorizadoResult><CbteNro>${nro}</CbteNro></FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse></Body></Envelope>`;
const CAE = (nro) =>
  `<Envelope><Body><FECAESolicitarResponse><FECAESolicitarResult><FeDetResp><FECAEDetResponse><CAE>123</CAE><CAEFchVto>20261106</CAEFchVto><CbteHasta>${nro}</CbteHasta><Resultado>A</Resultado></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse></Body></Envelope>`;

const tokenDe = (xml) => (xml.match(/<(?:\w+:)?Token>([^<]*)</) || [])[1];

// Mocks ANTES de requerir wsfev1 (que destructura callSoap al cargar).
mock.method(soapMod, 'callSoap', async (url, action, xml) => {
  const metodo = action.split('/').pop();
  llamadas.push([metodo, tokenDe(xml)]);
  return respuestas[metodo](xml);
});
mock.method(wsaaMod, 'obtenerLoginTicketResponse', async () => ({ token: tokens[0], sign: 's' }));
mock.method(tokenCache, 'clear', async () => { borrados++; tokens.shift(); });

const wsfev1 = require('../../src/services/wsfev1');
const empresa = { id: 1, cuit: '20219547006' };
const factura = { punto_vta: 2, tipo_cbte: 11, iva: [], tributos: [], concepto: 1, moneda: 'PES', moneda_cotizacion: 1, imp_total: 1, imp_neto: 1 };

beforeEach(() => {
  tokens = ['viejo', 'nuevo', 'otro'];
  llamadas = [];
  borrados = 0;
});

test('600 → borra el ticket, pide uno nuevo y reintenta', async () => {
  respuestas = { FECompUltimoAutorizado: (xml) => (tokenDe(xml) === 'viejo' ? ERR('FECompUltimoAutorizado', 600) : ULTIMO(10)) };
  const r = await wsfev1.FECompUltimoAutorizado(empresa, 2, 11);
  assert.equal(r.ultimo_numero, 10);
  assert.equal(borrados, 1);
  assert.deepEqual(llamadas, [['FECompUltimoAutorizado', 'viejo'], ['FECompUltimoAutorizado', 'nuevo']]);
});

test('600 al emitir → reintenta la emisión con el ticket nuevo y recalcula el número', async () => {
  let ultimo = 10;
  respuestas = {
    FECompUltimoAutorizado: () => ULTIMO(ultimo),
    FECAESolicitar: (xml) => (tokenDe(xml) === 'viejo' ? ERR('FECAESolicitar', 600) : CAE(ultimo + 1)),
  };
  const r = await wsfev1.FECAESolicitar(empresa, factura);
  assert.equal(r.cae, '123');
  assert.equal(r.numero_comprobante, 11);
  assert.equal(borrados, 1);
  const emisiones = llamadas.filter(([m]) => m === 'FECAESolicitar');
  assert.deepEqual(emisiones, [['FECAESolicitar', 'viejo'], ['FECAESolicitar', 'nuevo']]);
});

test('600 también con el ticket nuevo → un solo reintento y devuelve el error', async () => {
  respuestas = { FECompUltimoAutorizado: () => ERR('FECompUltimoAutorizado', 600) };
  await assert.rejects(wsfev1.FECompUltimoAutorizado(empresa, 2, 11), (err) => err.codigo_afip === 600);
  assert.equal(llamadas.length, 2);
  assert.equal(borrados, 2);
});

test('otro error de AFIP → no reintenta ni borra el ticket', async () => {
  respuestas = { FECompUltimoAutorizado: () => ERR('FECompUltimoAutorizado', 10016) };
  await assert.rejects(wsfev1.FECompUltimoAutorizado(empresa, 2, 11), (err) => err.codigo_afip === 10016);
  assert.equal(llamadas.length, 1);
  assert.equal(borrados, 0);
});
