const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseXml,
  buildLoginTicketRequest,
  buildLoginCmsSoap,
  buildFEDummySoap,
  buildFECompUltimoAutorizadoSoap,
  buildFECAESolicitarSoap,
  buildFECompConsultarSoap,
  buildParamSoap,
} = require('../../src/utils/xml');

const emitirData = {
  punto_vta: 2,
  tipo_cbte: 6,
  concepto: 1,
  tipo_doc: 80,
  nro_doc: 30711479295,
  fecha_cbte: '20260410',
  imp_total: 121,
  imp_neto: 100,
  imp_iva: 21,
  moneda: 'PES',
  moneda_cotizacion: 1,
  condicion_iva_receptor_id: 5,
  iva: [{ id: 5, base_imp: 100, importe: 21 }],
  tributos: [],
};

test('buildLoginTicketRequest: estructura y expiración posterior a generación', async () => {
  const ltr = buildLoginTicketRequest('wsfe');
  const parsed = await parseXml(ltr);
  assert.equal(parsed.loginTicketRequest.service, 'wsfe');
  const { generationTime, expirationTime } = parsed.loginTicketRequest.header;
  assert.ok(new Date(expirationTime) > new Date(generationTime));
  assert.match(generationTime, /-03:00$/, 'offset Argentina');
});

test('buildLoginCmsSoap: incrusta el CMS en in0', async () => {
  const soap = buildLoginCmsSoap('BASE64CMS==');
  assert.match(soap, /<log:in0>BASE64CMS==<\/log:in0>/);
});

test('buildFEDummySoap: FEDummy en el body', async () => {
  const parsed = await parseXml(buildFEDummySoap());
  assert.ok('FEDummy' in parsed.Envelope.Body);
});

test('buildFECompUltimoAutorizadoSoap: Auth + PtoVta + CbteTipo', async () => {
  const parsed = await parseXml(buildFECompUltimoAutorizadoSoap('T', 'S', '30714794295', 2, 6));
  const call = parsed.Envelope.Body.FECompUltimoAutorizado;
  assert.equal(call.Auth.Token, 'T');
  assert.equal(call.Auth.Sign, 'S');
  assert.equal(call.Auth.Cuit, '30714794295');
  assert.equal(call.PtoVta, '2');
  assert.equal(call.CbteTipo, '6');
});

test('buildFECAESolicitarSoap: incluye Iva y CondicionIVAReceptorId, importes con 2 decimales', async () => {
  const parsed = await parseXml(buildFECAESolicitarSoap('T', 'S', '30714794295', emitirData, 421));
  const det = parsed.Envelope.Body.FECAESolicitar.FeCAEReq.FeDetReq.FECAEDetRequest;
  assert.equal(det.CbteDesde, '421');
  assert.equal(det.CbteHasta, '421');
  assert.equal(det.ImpTotal, '121.00');
  assert.equal(det.ImpNeto, '100.00');
  assert.equal(det.CondicionIVAReceptorId, '5');
  assert.equal(det.Iva.AlicIva.Id, '5');
  assert.equal(det.Iva.AlicIva.BaseImp, '100.00');
  assert.equal(det.Iva.AlicIva.Importe, '21.00');
});

test('buildFECAESolicitarSoap: sin Iva ni Tributos cuando están vacíos', async () => {
  const soap = buildFECAESolicitarSoap('T', 'S', '30714794295', { ...emitirData, iva: [], tributos: [] }, 1);
  assert.doesNotMatch(soap, /<ar:Iva>/);
  assert.doesNotMatch(soap, /<ar:Tributos>/);
});

test('buildFECAESolicitarSoap: concepto 2 agrega fechas de servicio', async () => {
  const soap = buildFECAESolicitarSoap('T', 'S', '30714794295', {
    ...emitirData,
    concepto: 2,
    fecha_serv_desde: '20260401',
    fecha_serv_hasta: '20260430',
    fecha_venc_pago: '20260510',
  }, 1);
  assert.match(soap, /<ar:FchServDesde>20260401<\/ar:FchServDesde>/);
  assert.match(soap, /<ar:FchVtoPago>20260510<\/ar:FchVtoPago>/);
});

test('buildFECAESolicitarSoap: comprobante asociado y leyenda', async () => {
  const parsed = await parseXml(buildFECAESolicitarSoap('T', 'S', '30714794295', {
    ...emitirData,
    tipo_cbte: 8,
    comprobante_asociado: { tipo: 6, pto_vta: 2, nro: 100, fecha: '20260401' },
    leyenda: { id: 1, texto: 'RG 1415' },
  }, 1));
  const det = parsed.Envelope.Body.FECAESolicitar.FeCAEReq.FeDetReq.FECAEDetRequest;
  assert.equal(det.CbtesAsoc.CbteAsoc.Nro, '100');
  assert.equal(det.CbtesAsoc.CbteAsoc.Cuit, '30714794295');
  assert.equal(det.Opcionales.Opcional.Id, '1');
  assert.equal(det.Opcionales.Opcional.Valor, 'RG 1415');
});

test('buildFECompConsultarSoap: arma FeCompConsReq', async () => {
  const parsed = await parseXml(buildFECompConsultarSoap('T', 'S', '30714794295', 2, 6, 421));
  const q = parsed.Envelope.Body.FECompConsultar.FeCompConsReq;
  assert.equal(q.CbteNro, '421');
  assert.equal(q.PtoVta, '2');
  assert.equal(q.CbteTipo, '6');
});

test('buildParamSoap: método dinámico y extra opcional', async () => {
  const parsed = await parseXml(buildParamSoap('FEParamGetCotizacion', 'T', 'S', '30714794295', '<ar:MonId>DOL</ar:MonId>'));
  assert.equal(parsed.Envelope.Body.FEParamGetCotizacion.MonId, 'DOL');
  assert.equal(parsed.Envelope.Body.FEParamGetCotizacion.Auth.Cuit, '30714794295');
});

test('parseXml: stripPrefix y explicitArray:false', async () => {
  const parsed = await parseXml('<soapenv:Envelope xmlns:soapenv="x"><soapenv:Body><Foo><Bar>1</Bar></Foo></soapenv:Body></soapenv:Envelope>');
  assert.equal(parsed.Envelope.Body.Foo.Bar, '1');
});
