const express = require('express');
const router = express.Router();
const wsfev1 = require('../services/wsfev1');
const idempotencia = require('../services/idempotencia');
const pool = require('../config/database');
const validate = require('../middleware/validate');

router.get('/ultimo-comprobante', validate('ultimoComprobante', 'query'), async (req, res, next) => {
  try {
    const result = await wsfev1.FECompUltimoAutorizado(
      req.empresa,
      req.query.pto_vta,
      req.query.tipo_cbte
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.post('/emitir', validate('emitir'), async (req, res, next) => {
  const endpoint = req.originalUrl.split('?')[0];
  const clave = req.body.clave_idempotencia;
  try {
    const claim = await idempotencia.reclamar(
      req.empresa.id, clave, req.body.punto_vta, req.body.tipo_cbte
    );

    if (claim.estado === 'listo') {
      const d = claim.datos;
      return res.json({
        ok: true,
        cae: d.cae,
        vencimiento_cae: d.vencimiento_cae,
        numero_comprobante: d.numero_comprobante,
        resultado: d.resultado,
        observaciones: [],
        reintento: true,
      });
    }

    if (claim.estado === 'en_curso') {
      return res.status(409).json({
        ok: false,
        error: 'Ya hay una emisión en curso para esta clave de idempotencia, reintente en unos segundos',
      });
    }

    let result;
    try {
      result = await wsfev1.FECAESolicitar(req.empresa, req.body);
    } catch (err) {
      await idempotencia.liberar(req.empresa.id, clave);
      throw err;
    }

    await pool.execute(
      'INSERT INTO facturas_log (empresa_id, endpoint, request, response, cae, resultado) VALUES (?, ?, ?, ?, ?, ?)',
      [
        req.empresa.id,
        endpoint,
        JSON.stringify(req.body),
        JSON.stringify(result),
        result.cae,
        result.resultado,
      ]
    );

    if (result.resultado === 'A' && result.cae) {
      await idempotencia.confirmar(req.empresa.id, clave, result);
    } else {
      // Rechazo de AFIP: se libera la clave para que HPM pueda reintentar tras corregir.
      await idempotencia.liberar(req.empresa.id, clave);
    }

    res.json({ ok: true, ...result, reintento: false });
  } catch (err) {
    next(err);
  }
});

router.get('/consultar', validate('consultar', 'query'), async (req, res, next) => {
  try {
    const result = await wsfev1.FECompConsultar(
      req.empresa,
      req.query.pto_vta,
      req.query.tipo_cbte,
      req.query.nro
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
