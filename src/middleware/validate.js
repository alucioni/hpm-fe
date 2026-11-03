const Joi = require('joi');

const schemas = {
  emitir: Joi.object({
    cuit_emisor: Joi.string().pattern(/^\d{11}$/).required(),
    clave_idempotencia: Joi.number().integer().positive().required(),
    tipo_cbte: Joi.number().integer().required(),
    punto_vta: Joi.number().integer().required(),
    fecha_cbte: Joi.string().pattern(/^\d{8}$/).required(),
    tipo_doc: Joi.number().integer().required(),
    nro_doc: Joi.number().required(),
    condicion_iva_receptor_id: Joi.number().integer().required(),
    concepto: Joi.number().valid(1, 2, 3).required(),
    fecha_serv_desde: Joi.when('concepto', {
      is: Joi.valid(2, 3),
      then: Joi.string().pattern(/^\d{8}$/).required(),
      otherwise: Joi.valid(null).optional().default(null),
    }),
    fecha_serv_hasta: Joi.when('concepto', {
      is: Joi.valid(2, 3),
      then: Joi.string().pattern(/^\d{8}$/).required(),
      otherwise: Joi.valid(null).optional().default(null),
    }),
    fecha_venc_pago: Joi.when('concepto', {
      is: Joi.valid(2, 3),
      then: Joi.string().pattern(/^\d{8}$/).required(),
      otherwise: Joi.valid(null).optional().default(null),
    }),
    imp_total: Joi.number().required(),
    imp_neto: Joi.number().required(),
    imp_iva: Joi.number().default(0),
    imp_trib: Joi.number().default(0),
    imp_op_ex: Joi.number().default(0),
    imp_tot_conc: Joi.number().default(0),
    moneda: Joi.string().default('PES'),
    moneda_cotizacion: Joi.number().default(1),
    iva: Joi.array().items(Joi.object({
      id: Joi.number().integer().required(),
      base_imp: Joi.number().required(),
      importe: Joi.number().required(),
    })).default([]),
    tributos: Joi.array().items(Joi.object({
      id: Joi.number().integer().required(),
      desc: Joi.string().allow('').default(''),
      base_imp: Joi.number().required(),
      alic: Joi.number().required(),
      importe: Joi.number().required(),
    })).default([]),
    comprobante_asociado: Joi.object({
      tipo: Joi.number().integer().required(),
      pto_vta: Joi.number().integer().required(),
      nro: Joi.number().integer().required(),
      fecha: Joi.string().pattern(/^\d{8}$/).required(),
    }).allow(null).optional(),
    leyenda: Joi.object({
      id: Joi.number().integer().required(),
      texto: Joi.string().required(),
    }).allow(null).optional(),
  }),

  ultimoComprobante: Joi.object({
    pto_vta: Joi.number().integer().required(),
    tipo_cbte: Joi.number().integer().required(),
  }),

  consultar: Joi.object({
    tipo_cbte: Joi.number().integer().required(),
    pto_vta: Joi.number().integer().required(),
    nro: Joi.number().integer().required(),
  }),

  patchEmpresa: Joi.object({
    activo: Joi.boolean(),
    razon_social: Joi.string().min(1).max(255),
    cuit: Joi.string().pattern(/^\d{11}$/),
  }).or('activo', 'razon_social', 'cuit'),
};

function validate(schemaName, source = 'body') {
  return (req, res, next) => {
    const schema = schemas[schemaName];
    const { error, value } = schema.validate(req[source], { abortEarly: false, stripUnknown: true });
    if (error) {
      return res.status(422).json({
        ok: false,
        error: 'Error de validación',
        detalles: error.details.map(d => d.message),
      });
    }
    req[source] = value;
    next();
  };
}

module.exports = validate;
