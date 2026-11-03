const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseXml } = require('../../src/utils/xml');
const {
  aLineasHpm,
  buildGetPersonaSoap,
  buildGetIdPersonaListByDocumentoSoap,
  normalizarPersona,
} = require('../../src/services/padron');

test('buildGetPersonaSoap: namespace a13 y parametros', () => {
  const xml = buildGetPersonaSoap('TOK', 'SIG', '20219547006', '33693450239');
  assert.match(xml, /xmlns:a13="http:\/\/a13\.soap\.ws\.server\.puc\.sr\/"/);
  assert.match(xml, /<a13:getPersona>/);
  assert.match(xml, /<cuitRepresentada>20219547006<\/cuitRepresentada>/);
  assert.match(xml, /<idPersona>33693450239<\/idPersona>/);
});

test('buildGetIdPersonaListByDocumentoSoap: documento', () => {
  const xml = buildGetIdPersonaListByDocumentoSoap('TOK', 'SIG', '20219547006', '21954700');
  assert.match(xml, /<a13:getIdPersonaListByDocumento>/);
  assert.match(xml, /<documento>21954700<\/documento>/);
});

test('normalizarPersona: domicilio fiscal primero, actividad principal como categoria', async () => {
  const resp = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
    <ns2:getPersonaResponse xmlns:ns2="http://a13.soap.ws.server.puc.sr/"><personaReturn><persona>
      <apellido>PEREZ</apellido><nombre>JUAN</nombre><idPersona>20219547006</idPersona>
      <tipoDocumento>DNI</tipoDocumento><numeroDocumento>21954700</numeroDocumento>
      <fechaNacimiento>1970-05-01T12:00:00-03:00</fechaNacimiento><estadoClave>ACTIVO</estadoClave>
      <descripcionActividadPrincipal>SERVICIOS DE CONSULTORES EN INFORMATICA</descripcionActividadPrincipal>
      <idActividadPrincipal>620100</idActividadPrincipal><periodoActividadPrincipal>201311</periodoActividadPrincipal>
      <domicilio><direccion>SAN MARTIN 500</direccion><localidad>BARILOCHE</localidad><tipoDomicilio>LEGAL/REAL</tipoDomicilio></domicilio>
      <domicilio><direccion>MITRE 123</direccion><localidad>EL BOLSON</localidad><codigoPostal>8430</codigoPostal><tipoDomicilio>FISCAL</tipoDomicilio></domicilio>
    </persona></personaReturn></ns2:getPersonaResponse></soap:Body></soap:Envelope>`;
  const parsed = await parseXml(resp);
  const p = normalizarPersona(parsed.Envelope.Body.getPersonaResponse.personaReturn.persona);
  assert.equal(p.cuit, '20219547006');
  assert.equal(p.fechaNacimiento, '1970-05-01');
  assert.equal(p.domicilios[0].direccion, 'MITRE 123');
  assert.equal(p.domicilios[0].codPostal, '8430');
  assert.equal(p.domicilios[1].tipo, 'LEGAL/REAL');
  assert.deepEqual(p.telefonos, []);
  assert.equal(p.categorias.length, 1);
  assert.match(p.categorias[0].descripcion, /CONSULTORES EN INFORMATICA/);
});

test('normalizarPersona: un solo domicilio queda como lista', () => {
  const p = normalizarPersona({ razonSocial: 'ACME SA', idPersona: '30111111118', domicilio: { direccion: 'X 1', tipoDomicilio: 'FISCAL' } });
  assert.equal(p.domicilios.length, 1);
  assert.deepEqual(p.categorias, []);
});

test('aLineasHpm: claves de datos_padron y listas desde 1', () => {
  const base = {
    nombre: 'JUAN', apellido: 'PEREZ', cuit: '20219547006', razonSocial: '',
    tipoDocumento: 'DNI', fechaInscripcion: '', fechaContratoSocial: '', fechaFallecimiento: '',
    fechaNacimiento: '1970-05-01', fechaJubilado: '', sexo: '', formaJuridica: '',
    domicilios: [{ direccion: 'MITRE 123', localidad: 'EL BOLSON', tipo: 'FISCAL' }],
    telefonos: [],
    emails: [],
    categorias: [{ descripcion: 'ACTIVIDAD PRINCIPAL: X', idImpuesto: '620100', estado: 'ACTIVO', periodo: '201311' }],
  };
  const lineas = aLineasHpm(base).split('\r\n');
  assert.ok(lineas.includes('apellido=PEREZ'));
  assert.ok(lineas.includes('direccion1=MITRE 123'));
  assert.ok(lineas.includes('domicilio_localidad1=EL BOLSON'));
  assert.ok(lineas.includes('categoria1=ACTIVIDAD PRINCIPAL: X -- 620100 -- ACTIVO -- 201311'));
  assert.ok(!lineas.some((x) => x.startsWith('fechaJubilado=')));
  assert.ok(!lineas.some((x) => x.startsWith('telefono')));
  const sa = aLineasHpm({ ...base, razonSocial: 'ACME SA' }).split('\r\n');
  assert.ok(sa.includes('RazonSocial=ACME SA'));
});
