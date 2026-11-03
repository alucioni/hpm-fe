const { callSoap } = require('../utils/soap');
const {
  parseXml,
  buildFEDummySoap,
  buildFECompUltimoAutorizadoSoap,
  buildFECAESolicitarSoap,
  buildFECompConsultarSoap,
  buildParamSoap,
} = require('../utils/xml');
const wsaa = require('./wsaa');
const tokenCache = require('./tokenCache');
const config = require('../config');

function extractErrors(result) {
  const errNode = result?.Errors?.Err;
  if (!errNode) return null;
  const errs = Array.isArray(errNode) ? errNode : [errNode];
  const err = new Error(errs.map(e => `[${e.Code}] ${e.Msg}`).join(' | '));
  err.codigo_afip = parseInt(errs[0].Code, 10);
  return err;
}

// Ejecuta una llamada a WSFEv1 con el ticket de WSAA de la empresa. Si AFIP responde
// 600 (ValidacionDeToken: token/sign vencido o inválido) se borra el ticket del cache, se
// pide uno nuevo y se reintenta una sola vez. Es seguro: con 600 AFIP no procesó el pedido.
async function conToken(empresa, llamada) {
  try {
    return await llamada(await wsaa.obtenerLoginTicketResponse(empresa));
  } catch (err) {
    if (err.codigo_afip !== 600) throw err;
    await tokenCache.clear(empresa.id);
  }
  try {
    return await llamada(await wsaa.obtenerLoginTicketResponse(empresa));
  } catch (err) {
    if (err.codigo_afip === 600) await tokenCache.clear(empresa.id);
    throw err;
  }
}

function extractObservaciones(node) {
  const obs = node?.Obs;
  if (!obs) return [];
  const arr = Array.isArray(obs) ? obs : [obs];
  return arr.map(o => ({ codigo: parseInt(o.Code, 10), mensaje: o.Msg }));
}

const NS = 'http://ar.gov.afip.dif.FEV1/';

// AFIP (producción) rechaza el request con HTTP 500 si el header SOAPAction no
// coincide con el método invocado. La SOAPAction es el namespace + nombre del método.
async function soap(method, xml) {
  return callSoap(config.afip.url, NS + method, xml);
}

async function FEDummy() {
  const responseXml = await soap('FEDummy', buildFEDummySoap());
  const parsed = await parseXml(responseXml);
  const r = parsed.Envelope.Body.FEDummyResponse.FEDummyResult;
  return {
    appserver: r.AppServer,
    dbserver: r.DbServer,
    authserver: r.AuthServer,
  };
}

async function FECompUltimoAutorizado(empresa, ptoVta, tipoCbte) {
  return conToken(empresa, async ({ token, sign }) => {
    const xml = buildFECompUltimoAutorizadoSoap(token, sign, empresa.cuit, ptoVta, tipoCbte);
    const responseXml = await soap('FECompUltimoAutorizado', xml);
    const parsed = await parseXml(responseXml);

    const fault = parsed?.Envelope?.Body?.Fault;
    if (fault) throw new Error(`SOAP Fault: ${fault.faultstring}`);

    const r = parsed.Envelope.Body.FECompUltimoAutorizadoResponse.FECompUltimoAutorizadoResult;
    const errObj = extractErrors(r);
    if (errObj) throw errObj;

    return { ultimo_numero: parseInt(r.CbteNro, 10) };
  });
}

async function FECAESolicitar(empresa, data) {
  return conToken(empresa, async ({ token, sign }) => {
    const ultimoNro = await FECompUltimoAutorizado(empresa, data.punto_vta, data.tipo_cbte);
    const cbteNro = ultimoNro.ultimo_numero + 1;

    const xml = buildFECAESolicitarSoap(token, sign, empresa.cuit, data, cbteNro);
    const responseXml = await soap('FECAESolicitar', xml);
    const parsed = await parseXml(responseXml);

    const fault = parsed?.Envelope?.Body?.Fault;
    if (fault) throw new Error(`SOAP Fault: ${fault.faultstring}`);

    const r = parsed.Envelope.Body.FECAESolicitarResponse.FECAESolicitarResult;
    const errObj = extractErrors(r);
    if (errObj) throw errObj;

    const det = r.FeDetResp.FECAEDetResponse;
    return {
      cae: det.CAE || null,
      vencimiento_cae: det.CAEFchVto || null,
      numero_comprobante: parseInt(det.CbteHasta, 10),
      resultado: det.Resultado,
      observaciones: extractObservaciones(det.Observaciones),
    };
  });
}

async function FECompConsultar(empresa, ptoVta, tipoCbte, nro) {
  return conToken(empresa, async ({ token, sign }) => {
    const xml = buildFECompConsultarSoap(token, sign, empresa.cuit, ptoVta, tipoCbte, nro);
    const responseXml = await soap('FECompConsultar', xml);
    const parsed = await parseXml(responseXml);

    const fault = parsed?.Envelope?.Body?.Fault;
    if (fault) throw new Error(`SOAP Fault: ${fault.faultstring}`);

    const r = parsed.Envelope.Body.FECompConsultarResponse.FECompConsultarResult;
    const errObj = extractErrors(r);
    if (errObj) throw errObj;

    const g = r.ResultGet;
    return {
      cae: g.CodAutorizacion,
      vencimiento_cae: g.FchVto,
      resultado: g.Resultado,
      fecha_cbte: g.CbteFch,
      imp_total: parseFloat(g.ImpTotal),
    };
  });
}

async function FEParamGet(empresa, method, itemKey) {
  return conToken(empresa, async ({ token, sign }) => {
    const xml = buildParamSoap(method, token, sign, empresa.cuit);
    const responseXml = await soap(method, xml);
    const parsed = await parseXml(responseXml);

    const fault = parsed?.Envelope?.Body?.Fault;
    if (fault) throw new Error(`SOAP Fault: ${fault.faultstring}`);

    const r = parsed.Envelope.Body[`${method}Response`][`${method}Result`];
    const errObj = extractErrors(r);
    if (errObj) throw errObj;

    const items = r.ResultGet[itemKey];
    const arr = Array.isArray(items) ? items : [items];
    return arr.map(i => ({ id: parseInt(i.Id, 10), desc: i.Desc }));
  });
}

async function FEParamGetPtosVenta(empresa) {
  return conToken(empresa, async ({ token, sign }) => {
    const xml = buildParamSoap('FEParamGetPtosVenta', token, sign, empresa.cuit);
    const responseXml = await soap('FEParamGetPtosVenta', xml);
    const parsed = await parseXml(responseXml);

    const fault = parsed?.Envelope?.Body?.Fault;
    if (fault) throw new Error(`SOAP Fault: ${fault.faultstring}`);

    const r = parsed.Envelope.Body.FEParamGetPtosVentaResponse.FEParamGetPtosVentaResult;
    const errObj = extractErrors(r);
    if (errObj) throw errObj;

    const items = r.ResultGet.PtoVenta;
    const arr = Array.isArray(items) ? items : [items];
    return arr.map(i => ({ id: parseInt(i.Nro, 10), desc: i.EmisionTipo }));
  });
}

async function FECotizacionMoneda(empresa, moneda) {
  return conToken(empresa, async ({ token, sign }) => {
    const extra = `<ar:MonId>${moneda}</ar:MonId>`;
    const xml = buildParamSoap('FEParamGetCotizacion', token, sign, empresa.cuit, extra);
    const responseXml = await soap('FEParamGetCotizacion', xml);
    const parsed = await parseXml(responseXml);

    const fault = parsed?.Envelope?.Body?.Fault;
    if (fault) throw new Error(`SOAP Fault: ${fault.faultstring}`);

    const r = parsed.Envelope.Body.FEParamGetCotizacionResponse.FEParamGetCotizacionResult;
    const errObj = extractErrors(r);
    if (errObj) throw errObj;

    return {
      moneda,
      cotizacion: parseFloat(r.ResultGet.Cotiz),
      fecha: r.ResultGet.FchCotiz,
    };
  });
}

module.exports = {
  FEDummy,
  FECompUltimoAutorizado,
  FECAESolicitar,
  FECompConsultar,
  FEParamGet,
  FEParamGetPtosVenta,
  FECotizacionMoneda,
};
