const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseXml } = require('../../src/utils/xml');
const {
  aLineasHpm,
  digitoVerificador,
  cuitsPosiblesDesdeDni,
  buildGetPersonaSoap,
  normalizarPersona,
} = require('../../src/services/padron');

test('digitoVerificador: CUITs reales', () => {
  assert.equal(digitoVerificador('3369345023'), 9); // AFIP 33-69345023-9
  assert.equal(digitoVerificador('2021954700'), 6); // 20-21954700-6
});

test('cuitsPosiblesDesdeDni: prefijos en el orden de la DLL y DNI de 7 digitos con cero', () => {
  const c = cuitsPosiblesDesdeDni('21954700');
  assert.deepEqual(c.map((x) => x.slice(0, 2)), ['20', '27', '23', '24', '25', '26']);
  assert.equal(c[0], '20219547006');
  assert.ok(cuitsPosiblesDesdeDni('1234567').every((x) => x.slice(2, 10) === '01234567'));
});

test('buildGetPersonaSoap: namespace a4 y parametros', () => {
  const xml = buildGetPersonaSoap('TOK', 'SIG', '20219547006', '33693450239');
  assert.match(xml, /xmlns:a4="http:\/\/a4\.soap\.ws\.server\.puc\.sr\/"/);
  assert.match(xml, /<cuitRepresentada>20219547006<\/cuitRepresentada>/);
  assert.match(xml, /<idPersona>33693450239<\/idPersona>/);
});

test('normalizarPersona: un solo domicilio/telefono queda como lista', async () => {
  const resp = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
    <ns2:getPersonaResponse xmlns:ns2="http://a4.soap.ws.server.puc.sr/"><personaReturn><persona>
      <apellido>PEREZ</apellido><nombre>JUAN</nombre><idPersona>20219547006</idPersona>
      <fechaNacimiento>1970-05-01T12:00:00-03:00</fechaNacimiento>
      <domicilio><direccion>MITRE 123</direccion><localidad>EL BOLSON</localidad><tipoDomicilio>FISCAL</tipoDomicilio></domicilio>
      <telefono><numero>2944123456</numero></telefono>
      <email><direccion>a@b.com</direccion><estado>CONFIRMADO</estado></email>
      <email><direccion>c@d.com</direccion><estado>NO CONFIRMADO</estado></email>
    </persona></personaReturn></ns2:getPersonaResponse></soap:Body></soap:Envelope>`;
  const parsed = await parseXml(resp);
  const p = normalizarPersona(parsed.Envelope.Body.getPersonaResponse.personaReturn.persona);
  assert.equal(p.cuit, '20219547006');
  assert.equal(p.fechaNacimiento, '1970-05-01');
  assert.deepEqual(p.domicilios, [{ direccion: 'MITRE 123', localidad: 'EL BOLSON', codPostal: '', provincia: '', tipo: 'FISCAL' }]);
  assert.deepEqual(p.telefonos, ['2944123456']);
  assert.equal(p.emails.length, 2);
  assert.deepEqual(p.categorias, []);
});

test('aLineasHpm: claves de datos_padron, listas desde 1 y categorias solo sin razon social', () => {
  const base = {
    nombre: 'JUAN', apellido: 'PEREZ', cuit: '20219547006', razonSocial: '',
    tipoDocumento: 'DNI', fechaInscripcion: '', fechaContratoSocial: '', fechaFallecimiento: '',
    fechaNacimiento: '1970-05-01', fechaJubilado: '', sexo: 'MASCULINO', formaJuridica: '',
    domicilios: [{ direccion: 'MITRE 123', localidad: 'EL BOLSON', tipo: 'FISCAL' }],
    telefonos: ['2944123456'],
    emails: [{ direccion: 'a@b.com', estado: 'CONFIRMADO' }],
    categorias: [{ descripcion: 'MONOTRIBUTO A', idImpuesto: '20', estado: 'ACTIVO', periodo: '202601' }],
  };
  const lineas = aLineasHpm(base).split('\r\n');
  assert.ok(lineas.includes('apellido=PEREZ'));
  assert.ok(lineas.includes('direccion1=MITRE 123'));
  assert.ok(lineas.includes('domicilio_localidad1=EL BOLSON'));
  assert.ok(lineas.includes('telefono1=2944123456'));
  assert.ok(lineas.includes('email1=a@b.com'));
  assert.ok(lineas.includes('categoria1=MONOTRIBUTO A -- 20 -- ACTIVO -- 202601'));
  assert.ok(!lineas.some((x) => x.startsWith('fechaJubilado=')));
  const sa = aLineasHpm({ ...base, razonSocial: 'ACME SA' }).split('\r\n');
  assert.ok(sa.includes('RazonSocial=ACME SA'));
  assert.ok(!sa.some((x) => x.startsWith('categoria')));
});
