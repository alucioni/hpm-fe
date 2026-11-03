const { callSoap } = require('../utils/soap');
const { parseXml } = require('../utils/xml');
const wsaa = require('./wsaa');
const config = require('../config');

// Consulta de padron ARCA alcance 4 (ws_sr_padron_a4), el mismo que usaba la DLL de HPM
// (cls_FE_Padron): trae domicilios, telefonos, emails y categorias.
const SERVICIO = 'ws_sr_padron_a4';

// Prefijos que se prueban cuando se consulta por DNI (mismo orden que la DLL):
// 20 hombre, 27 mujer, y los de casos especiales.
const PREFIJOS_DNI = ['20', '27', '23', '24', '25', '26'];

function digitoVerificador(cuit10) {
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let suma = 0;
  for (let i = 0; i < 10; i++) suma += Number(cuit10[i]) * pesos[i];
  const dv = 11 - (suma % 11);
  if (dv === 11) return 0;
  if (dv === 10) return 9;
  return dv;
}

function cuitsPosiblesDesdeDni(dni) {
  const d = String(dni).replace(/\D/g, '').padStart(8, '0');
  return PREFIJOS_DNI.map((p) => p + d + digitoVerificador(p + d));
}

function buildGetPersonaSoap(token, sign, cuitRepresentada, idPersona) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a4="http://a4.soap.ws.server.puc.sr/">
  <soapenv:Header/>
  <soapenv:Body>
    <a4:getPersona>
      <token>${token}</token>
      <sign>${sign}</sign>
      <cuitRepresentada>${cuitRepresentada}</cuitRepresentada>
      <idPersona>${idPersona}</idPersona>
    </a4:getPersona>
  </soapenv:Body>
</soapenv:Envelope>`;
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

function normalizarPersona(p) {
  return {
    cuit: texto(p.idPersona),
    apellido: texto(p.apellido),
    nombre: texto(p.nombre),
    razonSocial: texto(p.razonSocial),
    tipoPersona: texto(p.tipoPersona),
    tipoDocumento: texto(p.tipoDocumento),
    numeroDocumento: texto(p.numeroDocumento),
    estadoClave: texto(p.estadoClave),
    fechaInscripcion: fecha(p.fechaInscripcion),
    fechaContratoSocial: fecha(p.fechaContratoSocial),
    fechaFallecimiento: fecha(p.fechaFallecimiento),
    fechaNacimiento: fecha(p.fechaNacimiento),
    fechaJubilado: fecha(p.fechaJubilado),
    sexo: texto(p.sexo),
    formaJuridica: texto(p.formaJuridica),
    domicilios: lista(p.domicilio).map((d) => ({
      direccion: texto(d.direccion),
      localidad: texto(d.localidad),
      codPostal: texto(d.codPostal),
      provincia: texto(d.descripcionProvincia),
      tipo: texto(d.tipoDomicilio),
    })),
    telefonos: lista(p.telefono).map((t) => texto(t.numero)).filter(Boolean),
    emails: lista(p.email).map((e) => ({ direccion: texto(e.direccion), estado: texto(e.estado) })),
    categorias: lista(p.categoria).map((c) => ({
      descripcion: texto(c.descripcionCategoria),
      idImpuesto: texto(c.idImpuesto),
      estado: texto(c.estado),
      periodo: texto(c.periodo),
    })),
  };
}

// Devuelve la persona normalizada, o null si ARCA dice que no existe.
async function getPersona(token, sign, cuitRepresentada, idPersona) {
  const xml = buildGetPersonaSoap(token, sign, cuitRepresentada, idPersona);
  const respuesta = await callSoap(config.afip.padronA4Url, '', xml);
  const parsed = await parseXml(respuesta);

  const fault = parsed?.Envelope?.Body?.Fault;
  if (fault) {
    const msg = texto(fault.faultstring);
    if (/no existe persona/i.test(msg)) return null;
    const err = new Error(`Padron ARCA: ${msg}`);
    err.status = 502;
    throw err;
  }

  const persona = parsed?.Envelope?.Body?.getPersonaResponse?.personaReturn?.persona;
  return persona ? normalizarPersona(persona) : null;
}

// id: CUIT/CUIL de 11 digitos o DNI de 7-8 digitos. empresa: la del certificado de padron.
async function consultar(empresa, id) {
  const limpio = String(id).replace(/\D/g, '');
  const { token, sign } = await wsaa.obtenerLoginTicketServicio(empresa, SERVICIO);

  const candidatos = limpio.length === 11 ? [limpio] : cuitsPosiblesDesdeDni(limpio);
  for (const cuit of candidatos) {
    const persona = await getPersona(token, sign, empresa.cuit, cuit);
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
  p.domicilios.forEach((d, i) => {
    l.push([`direccion${i + 1}`, d.direccion], [`domicilio_localidad${i + 1}`, d.localidad], [`domicilio_tipo${i + 1}`, d.tipo]);
  });
  p.telefonos.forEach((t, i) => l.push([`telefono${i + 1}`, t]));
  p.emails.forEach((e, i) => l.push([`email${i + 1}`, e.direccion], [`email_estado${i + 1}`, e.estado]));
  if (!p.razonSocial) {
    p.categorias.forEach((c, i) => {
      l.push([`categoria${i + 1}`, `${c.descripcion} -- ${c.idImpuesto} -- ${c.estado} -- ${c.periodo}`]);
    });
  }
  return l.filter(([, v]) => limpiar(v) !== '').map(([k, v]) => `${k}=${limpiar(v)}`).join('\r\n');
}

module.exports = {
  consultar,
  aLineasHpm,
  // exportadas para los tests
  digitoVerificador,
  cuitsPosiblesDesdeDni,
  buildGetPersonaSoap,
  normalizarPersona,
};
