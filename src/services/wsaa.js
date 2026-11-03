const { callSoap } = require('../utils/soap');
const { parseXml, buildLoginTicketRequest, buildLoginCmsSoap } = require('../utils/xml');
const { signCMS, decryptPassword } = require('./crypto');
const tokenCache = require('./tokenCache');
const config = require('../config');

async function loginCMS(cmsBase64) {
  const soapXml = buildLoginCmsSoap(cmsBase64);
  const responseXml = await callSoap(config.afip.wsaaUrl, '', soapXml);

  const parsed = await parseXml(responseXml);

  const fault = parsed?.Envelope?.Body?.Fault;
  if (fault) throw new Error(`WSAA Fault: ${fault.faultstring}`);

  const loginCmsReturn = parsed?.Envelope?.Body?.loginCmsResponse?.loginCmsReturn;
  if (!loginCmsReturn) throw new Error('WSAA: respuesta inesperada');

  const inner = await parseXml(loginCmsReturn);
  const resp = inner.loginTicketResponse;

  return {
    token: resp.credentials.token,
    sign: resp.credentials.sign,
    expiresAt: new Date(resp.header.expirationTime),
  };
}

async function obtenerLoginTicketResponse(empresa) {
  const cached = await tokenCache.get(empresa.id);
  if (cached) return { token: cached.token, sign: cached.sign };

  const ltr = buildLoginTicketRequest('wsfe');
  const password = decryptPassword(empresa.p12_password_encrypted);
  const cms = signCMS(ltr, empresa.p12_data, password);

  const { token, sign, expiresAt } = await loginCMS(cms);
  await tokenCache.set(empresa.id, token, sign, expiresAt);

  return { token, sign };
}

// Igual que obtenerLoginTicketResponse pero para otro servicio WSAA (ej. ws_sr_padron_a4),
// con su propio cache para no pisar el token de wsfe.
async function obtenerLoginTicketServicio(empresa, servicio) {
  const cached = await tokenCache.getServicio(empresa.id, servicio);
  if (cached) return { token: cached.token, sign: cached.sign };

  const ltr = buildLoginTicketRequest(servicio);
  const password = decryptPassword(empresa.p12_password_encrypted);
  const cms = signCMS(ltr, empresa.p12_data, password);

  const { token, sign, expiresAt } = await loginCMS(cms);
  await tokenCache.setServicio(empresa.id, servicio, token, sign, expiresAt);

  return { token, sign };
}

module.exports = { obtenerLoginTicketResponse, obtenerLoginTicketServicio, loginCMS };
