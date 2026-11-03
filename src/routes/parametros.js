const express = require('express');
const router = express.Router();
const wsfev1 = require('../services/wsfev1');

router.get('/tipos-comprobante', async (req, res, next) => {
  try {
    const datos = await wsfev1.FEParamGet(req.empresa, 'FEParamGetTiposCbte', 'CbteTipo');
    res.json({ ok: true, datos });
  } catch (err) {
    next(err);
  }
});

router.get('/tipos-documento', async (req, res, next) => {
  try {
    const datos = await wsfev1.FEParamGet(req.empresa, 'FEParamGetTiposDoc', 'DocTipo');
    res.json({ ok: true, datos });
  } catch (err) {
    next(err);
  }
});

router.get('/tipos-iva', async (req, res, next) => {
  try {
    const datos = await wsfev1.FEParamGet(req.empresa, 'FEParamGetAlicIva', 'AlicIva');
    res.json({ ok: true, datos });
  } catch (err) {
    next(err);
  }
});

router.get('/cotizacion/:moneda', async (req, res, next) => {
  try {
    const datos = await wsfev1.FECotizacionMoneda(req.empresa, req.params.moneda);
    res.json({ ok: true, datos });
  } catch (err) {
    next(err);
  }
});

router.get('/puntos-venta', async (req, res, next) => {
  try {
    const datos = await wsfev1.FEParamGetPtosVenta(req.empresa);
    res.json({ ok: true, datos });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
