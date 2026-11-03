const { callSoap } = require('../utils/soap');
const { parseXml } = require('../utils/xml');
const wsaa = require('./wsaa');
const config = require('../config');

// Condicion frente al IVA desde la Constancia de Inscripcion (padron A5,
// ws_sr_constancia_inscripcion, getPersona_v2). El A13 no informa impuestos, por eso se
// consulta aparte. Los ids son los de Empresas_Posicion_IVA de HPM (ver FE_Tipo_Empresa_IVA):
//   1 Responsable Inscripto, 3 Exento, 4 Consumidor Final, 5 Monotributo
const SERVICIO = 'ws_sr_constancia_inscripcion';
const ID_IMPUESTO_IVA = '30';
const ID_IMPUESTO_IVA_EXENTO = '32';

function lista(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => x != null && x !== '');
}

function texto(v) {
  return v == null ? '' : String(v).trim();
}

function buildGetPersonaV2Soap(token, sign, cuitRepresentada, idPersona) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="http://a5.soap.ws.server.puc.sr/">
  <soapenv:Header/>
  <soapenv:Body>
    <a5:getPersona_v2>
      <token>${token}</token>
      <sign>${sign}</sign>
      <cuitRepresentada>${cuitRepresentada}</cuitRepresentada>
      <idPersona>${idPersona}</idPersona>
    </a5:getPersona_v2>
  </soapenv:Body>
</soapenv:Envelope>`;
}

// personaReturn del A5 -> { id, descripcion } con el id de HPM, o null si no se puede deducir.
function condicionDesdePersonaReturn(pr) {
  const mono = pr.datosMonotributo;
  if (mono && lista(mono.categoriaMonotributo).length) {
    return { id: 5, descripcion: 'Monotributo' };
  }

  const impuestos = [...lista(pr.datosRegimenGeneral && pr.datosRegimenGeneral.impuesto), ...lista(mono && mono.impuesto)];
  const activo = (id) => impuestos.some((i) => texto(i.idImpuesto) === id && /activo/i.test(texto(i.estadoImpuesto) || 'ACTIVO'));
  if (activo(ID_IMPUESTO_IVA)) return { id: 1, descripcion: 'Responsable Inscripto' };
  if (activo(ID_IMPUESTO_IVA_EXENTO)) return { id: 3, descripcion: 'Exento' };

  // Persona fisica sin IVA ni monotributo: consumidor final. Una sociedad sin IVA no se
  // deduce (puede ser exenta por otra via): se deja como esta en HPM.
  const g = pr.datosGenerales || {};
  if (/fisica/i.test(texto(g.tipoPersona))) return { id: 4, descripcion: 'Consumidor Final' };
  return null;
}

// Devuelve { id, descripcion } o null. No lanza: si el A5 no esta autorizado o falla, el
// padron A13 sigue respondiendo sin la condicion IVA (el motivo va en `error`).
// Si WSAA rechaza el servicio (certificado no autorizado), no se reintenta en cada consulta:
// cada intento suma ~1 s al padron. Se vuelve a probar pasados 10 minutos.
const ESPERA_SIN_AUTORIZACION_MS = 10 * 60 * 1000;
let sinAutorizacion = null; // { hasta, error }

async function condicionIva(empresa, cuit) {
  if (sinAutorizacion && Date.now() < sinAutorizacion.hasta) return { error: sinAutorizacion.error };
  try {
    let ticket;
    try {
      ticket = await wsaa.obtenerLoginTicketServicio(empresa, SERVICIO);
    } catch (e) {
      if (/no autorizado/i.test(e.message)) {
        sinAutorizacion = { hasta: Date.now() + ESPERA_SIN_AUTORIZACION_MS, error: `${SERVICIO}: ${e.message}` };
      }
      throw e;
    }
    sinAutorizacion = null;
    const { token, sign } = ticket;
    const respuesta = await callSoap(config.afip.constanciaUrl, '', buildGetPersonaV2Soap(token, sign, empresa.cuit, cuit));
    const parsed = await parseXml(respuesta);
    const fault = parsed?.Envelope?.Body?.Fault;
    if (fault) return { error: `Constancia ARCA: ${texto(fault.faultstring)}` };
    const pr = parsed?.Envelope?.Body?.getPersona_v2Response?.personaReturn;
    if (!pr) return { error: 'Constancia ARCA: respuesta vacia' };
    const c = condicionDesdePersonaReturn(pr);
    return c || { error: 'Constancia ARCA: no se pudo deducir la condicion IVA' };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { condicionIva, condicionDesdePersonaReturn, buildGetPersonaV2Soap };
