const { test } = require('node:test');
const assert = require('node:assert/strict');
const validate = require('../../src/middleware/validate');
const { fakeRes } = require('../helpers');

// Corre el middleware de validación sincrónicamente y devuelve el estado resultante.
function run(schema, source, data) {
  const req = { [source]: data };
  const res = fakeRes();
  let nexted = false;
  validate(schema, source)(req, res, () => { nexted = true; });
  return { req, res, nexted };
}

const emitirBase = {
  cuit_emisor: '30714794295',
  clave_idempotencia: 12345,
  tipo_cbte: 6,
  punto_vta: 2,
  fecha_cbte: '20260410',
  tipo_doc: 80,
  nro_doc: 30711479295,
  condicion_iva_receptor_id: 5,
  concepto: 1,
  imp_total: 121,
  imp_neto: 100,
  imp_iva: 21,
  iva: [{ id: 5, base_imp: 100, importe: 21 }],
};

test('emitir: body válido pasa y aplica defaults', () => {
  const { req, res, nexted } = run('emitir', 'body', { ...emitirBase });
  assert.ok(nexted, 'debe llamar a next()');
  assert.equal(res.statusCode, 200);
  assert.equal(req.body.moneda, 'PES');
  assert.equal(req.body.moneda_cotizacion, 1);
  assert.deepEqual(req.body.tributos, []);
  assert.equal(req.body.imp_trib, 0);
  assert.equal(req.body.imp_op_ex, 0);
  assert.equal(req.body.imp_tot_conc, 0);
  assert.equal(req.body.fecha_serv_desde, null);
  assert.equal(req.body.fecha_serv_hasta, null);
  assert.equal(req.body.fecha_venc_pago, null);
});

test('emitir: falta cuit_emisor → 422', () => {
  const { cuit_emisor, ...sinCuit } = emitirBase;
  const { res, nexted } = run('emitir', 'body', sinCuit);
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.ok, false);
  assert.ok(Array.isArray(res.body.detalles));
});

test('emitir: cuit_emisor con formato inválido → 422', () => {
  const { res } = run('emitir', 'body', { ...emitirBase, cuit_emisor: '30-71479429-5' });
  assert.equal(res.statusCode, 422);
});

test('emitir: falta clave_idempotencia → 422', () => {
  const { clave_idempotencia, ...sinClave } = emitirBase;
  const { res } = run('emitir', 'body', sinClave);
  assert.equal(res.statusCode, 422);
});

test('emitir: clave_idempotencia no entero positivo → 422', () => {
  assert.equal(run('emitir', 'body', { ...emitirBase, clave_idempotencia: -1 }).res.statusCode, 422);
  assert.equal(run('emitir', 'body', { ...emitirBase, clave_idempotencia: 'abc' }).res.statusCode, 422);
  assert.equal(run('emitir', 'body', { ...emitirBase, clave_idempotencia: 1.5 }).res.statusCode, 422);
});

test('emitir: fecha_cbte con formato inválido → 422', () => {
  const { res } = run('emitir', 'body', { ...emitirBase, fecha_cbte: '2026-04-10' });
  assert.equal(res.statusCode, 422);
});

test('emitir: concepto inválido → 422', () => {
  assert.equal(run('emitir', 'body', { ...emitirBase, concepto: 9 }).res.statusCode, 422);
});

test('emitir: concepto 2 exige fechas de servicio', () => {
  const { res } = run('emitir', 'body', { ...emitirBase, concepto: 2 });
  assert.equal(res.statusCode, 422, 'sin fecha_serv_desde/hasta/venc debe fallar');
});

test('emitir: concepto 3 con fechas de servicio pasa', () => {
  const { req, res, nexted } = run('emitir', 'body', {
    ...emitirBase,
    concepto: 3,
    fecha_serv_desde: '20260401',
    fecha_serv_hasta: '20260430',
    fecha_venc_pago: '20260510',
  });
  assert.ok(nexted);
  assert.equal(res.statusCode, 200);
  assert.equal(req.body.fecha_serv_desde, '20260401');
});

test('emitir: stripUnknown descarta campos no declarados', () => {
  const { req } = run('emitir', 'body', { ...emitirBase, campo_raro: 'x', otro: 123 });
  assert.equal(req.body.campo_raro, undefined);
  assert.equal(req.body.otro, undefined);
});

test('emitir: item de iva sin importe → 422', () => {
  const { res } = run('emitir', 'body', {
    ...emitirBase,
    iva: [{ id: 5, base_imp: 100 }],
  });
  assert.equal(res.statusCode, 422);
});

test('emitir: tributo válido con desc opcional', () => {
  const { req, nexted } = run('emitir', 'body', {
    ...emitirBase,
    tributos: [{ id: 99, base_imp: 100, alic: 1, importe: 1 }],
  });
  assert.ok(nexted);
  assert.equal(req.body.tributos[0].desc, '');
});

test('emitir: comprobante_asociado y leyenda válidos', () => {
  const { nexted } = run('emitir', 'body', {
    ...emitirBase,
    tipo_cbte: 8,
    comprobante_asociado: { tipo: 6, pto_vta: 2, nro: 100, fecha: '20260401' },
    leyenda: { id: 1, texto: 'RG 1415' },
  });
  assert.ok(nexted);
});

test('emitir: comprobante_asociado incompleto → 422', () => {
  const { res } = run('emitir', 'body', {
    ...emitirBase,
    comprobante_asociado: { tipo: 6, pto_vta: 2 },
  });
  assert.equal(res.statusCode, 422);
});

test('ultimoComprobante: pto_vta y tipo_cbte requeridos', () => {
  assert.equal(run('ultimoComprobante', 'query', {}).res.statusCode, 422);
  assert.ok(run('ultimoComprobante', 'query', { pto_vta: 2, tipo_cbte: 6 }).nexted);
});

test('consultar: tipo_cbte, pto_vta y nro requeridos', () => {
  assert.equal(run('consultar', 'query', { tipo_cbte: 6, pto_vta: 2 }).res.statusCode, 422);
  assert.ok(run('consultar', 'query', { tipo_cbte: 6, pto_vta: 2, nro: 1 }).nexted);
});

test('patchEmpresa: activo booleano requerido', () => {
  assert.equal(run('patchEmpresa', 'body', {}).res.statusCode, 422);
  assert.equal(run('patchEmpresa', 'body', { activo: 'si' }).res.statusCode, 422);
  assert.ok(run('patchEmpresa', 'body', { activo: false }).nexted);
});

test('patchEmpresa: cuit de 11 dígitos', () => {
  assert.ok(run('patchEmpresa', 'body', { cuit: '20219547006' }).nexted);
  assert.equal(run('patchEmpresa', 'body', { cuit: '20-21954700-6' }).res.statusCode, 422);
  assert.equal(run('patchEmpresa', 'body', { cuit: '2021954700' }).res.statusCode, 422);
});
