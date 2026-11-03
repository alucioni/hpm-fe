const { callSoap } = require('../utils/soap');
const { parseXml } = require('../utils/xml');
const wsaa = require('./wsaa');
const config = require('../config');

// Consulta de padron ARCA alcance 13 (ws_sr_padron_a13). La DLL de HPM usaba el alcance 4,
// pero ARCA ya no deja adherir el A4 (ni el A10). El A13 trae datos de la persona, domicilios
// y actividad principal; no trae telefonos, emails ni impuestos.
const SERVICIO = 'ws_sr_padron_a13';
const NS = 'http://a13.soap.ws.server.puc.sr/';

function soap(metodo, cuerpo) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a13="${NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <a13:${metodo}>
${cuerpo}
    </a13:${metodo}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildGetPersonaSoap(token, sign, cuitRepresentada, idPersona) {
  return soap('getPersona', `      <token>${token}</token>
      <sign>${sign}</sign>
      <cuitRepresentada>${cuitRepresentada}</cuitRepresentada>
      <idPersona>${idPersona}</idPersona>`);
}

function buildGetIdPersonaListByDocumentoSoap(token, sign, cuitRepresentada, documento) {
  return soap('getIdPersonaListByDocumento', `      <token>${token}</token>
      <sign>${sign}</sign>
      <cuitRepresentada>${cuitRepresentada}</cuitRepresentada>
      <documento>${documento}</documento>`);
}

// xml2js con explicitArray:false deja un objeto suelto cuando hay un solo elemento.
function lista(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => x != null && x !== '');
}

function texto(v) {
  return v == null ? '' : String(v).trim();
}

function fecha(v) {
  // AFIP manda dateTime ISO; para HPM alcanza con la fecha
  const s = texto(v);
  return s ? s.slice(0, 10) : '';
}

// El domicilio fiscal primero: HPM vuelca direccion1 / domicilio_localidad1.
function ordenDomicilio(d) {
  return /fiscal/i.test(d.tipo) ? 0 : 1;
}

function normalizarPersona(p) {
  const domicilios = lista(p.domicilio).map((d) => ({
    direccion: texto(d.direccion),
    // En CABA ARCA no manda localidad: se usa la provincia ("CIUDAD AUTONOMA BUENOS AIRES")
    localidad: texto(d.localidad) || texto(d.descripcionProvincia),
    codPostal: texto(d.codigoPostal),
    provincia: texto(d.descripcionProvincia),
    tipo: texto(d.tipoDomicilio),
  })).sort((a, b) => ordenDomicilio(a) - ordenDomicilio(b));

  const categorias = [];
  if (texto(p.descripcionActividadPrincipal)) {
    categorias.push({
      descripcion: `ACTIVIDAD PRINCIPAL: ${texto(p.descripcionActividadPrincipal)}`,
      idImpuesto: texto(p.idActividadPrincipal),
      estado: texto(p.estadoClave),
      periodo: texto(p.periodoActividadPrincipal),
    });
  }

  return {
    cuit: texto(p.idPersona),
    apellido: texto(p.apellido),
    nombre: texto(p.nombre),
    razonSocial: texto(p.razonSocial),
    tipoPersona: texto(p.tipoPersona),
    tipoDocumento: texto(p.tipoDocumento),
    numeroDocumento: texto(p.numeroDocumento),
    estadoClave: texto(p.estadoClave),
    fechaInscripcion: '',
    fechaContratoSocial: fecha(p.fechaContratoSocial),
    fechaFallecimiento: fecha(p.fechaFallecimiento),
    fechaNacimiento: fecha(p.fechaNacimiento),
    fechaJubilado: '',
    sexo: '',
    formaJuridica: texto(p.formaJuridica),
    domicilios,
    telefonos: [],
    emails: [],
    categorias,
  };
}

async function llamar(xml) {
  const respuesta = await callSoap(config.afip.padronUrl, '', xml);
  const parsed = await parseXml(respuesta);
  const fault = parsed?.Envelope?.Body?.Fault;
  if (fault) {
    const msg = texto(fault.faultstring);
    if (/no existe/i.test(msg)) return null;
    const err = new Error(`Padron ARCA: ${msg}`);
    err.status = 502;
    throw err;
  }
  return parsed?.Envelope?.Body || {};
}

// Devuelve la persona normalizada, o null si ARCA dice que no existe.
async function getPersona(token, sign, cuitRepresentada, idPersona) {
  const body = await llamar(buildGetPersonaSoap(token, sign, cuitRepresentada, idPersona));
  const persona = body?.getPersonaResponse?.personaReturn?.persona;
  return persona ? normalizarPersona(persona) : null;
}

// CUITs/CUILs asociados a un DNI.
async function idsPorDocumento(token, sign, cuitRepresentada, documento) {
  const body = await llamar(buildGetIdPersonaListByDocumentoSoap(token, sign, cuitRepresentada, documento));
  return lista(body?.getIdPersonaListByDocumentoResponse?.idPersonaListReturn?.idPersona).map(texto);
}

// id: CUIT/CUIL de 11 digitos o DNI de 7-8 digitos. empresa: la del certificado de padron.
async function consultar(empresa, id) {
  const limpio = String(id).replace(/\D/g, '');
  let ticket;
  try {
    ticket = await wsaa.obtenerLoginTicketServicio(empresa, SERVICIO);
  } catch (e) {
    e.status = 502;
    throw e;
  }

  const candidatos = limpio.length === 11
    ? [limpio]
    : await idsPorDocumento(ticket.token, ticket.sign, empresa.cuit, String(Number(limpio)));
  for (const cuit of candidatos) {
    const persona = await getPersona(ticket.token, ticket.sign, empresa.cuit, cuit);
    if (persona) return persona;
  }
  return null;
}

// Formato para HPM (VB6, sin parser JSON): lineas "clave=valor" con las mismas claves que
// armaba datos_padron con la DLL. Las listas van desde el indice 1 (la DLL dejaba el 0 vacio).
function aLineasHpm(p) {
  const limpiar = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
  const l = [
    ['nombre', p.nombre], ['apellido', p.apellido], ['cuit', p.cuit], ['RazonSocial', p.razonSocial],
    ['tipoDocumento', p.tipoDocumento], ['fechaInscripcion', p.fechaInscripcion],
    ['fechaContratoSocial', p.fechaContratoSocial], ['fechaFallecimiento', p.fechaFallecimiento],
    ['fechaNacimiento', p.fechaNacimiento], ['fechaJubilado', p.fechaJubilado],
    ['sexo', p.sexo], ['formaJuridica', p.formaJuridica],
  ];
  p.domicilios.slice(0, 10).forEach((d, i) => {
    l.push([`direccion${i + 1}`, d.direccion], [`domicilio_localidad${i + 1}`, d.localidad], [`domicilio_tipo${i + 1}`, d.tipo]);
  });
  p.telefonos.slice(0, 10).forEach((t, i) => l.push([`telefono${i + 1}`, t]));
  p.emails.slice(0, 10).forEach((e, i) => l.push([`email${i + 1}`, e.direccion], [`email_estado${i + 1}`, e.estado]));
  p.categorias.slice(0, 10).forEach((c, i) => {
    l.push([`categoria${i + 1}`, `${c.descripcion} -- ${c.idImpuesto} -- ${c.estado} -- ${c.periodo}`]);
  });
  return l.filter(([, v]) => limpiar(v) !== '').map(([k, v]) => `${k}=${limpiar(v)}`).join('\r\n');
}

module.exports = {
  consultar,
  aLineasHpm,
  // exportadas para los tests
  buildGetPersonaSoap,
  buildGetIdPersonaListByDocumentoSoap,
  normalizarPersona,
};
