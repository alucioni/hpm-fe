const express = require('express');
const router = express.Router();
const padron = require('../services/padron');

// GET /api/v1/padron/:id  ->  id = CUIT/CUIL (11 digitos) o DNI (7-8 digitos)
// 200 { ok: true, persona: {...} } | 404 si ARCA no la encuentra | 422 si el id es invalido
// ?formato=hpm -> 200 text/plain con lineas "clave=valor" (lo que lee HPM / datos_padron)
router.get('/:id', async (req, res, next) => {
  const id = String(req.params.id || '').replace(/\D/g, '');
  if (id.length !== 11 && (id.length < 7 || id.length > 8)) {
    return res.status(422).json({ ok: false, error: 'Indique un CUIT/CUIL de 11 digitos o un DNI de 7 u 8 digitos' });
  }

  try {
    const persona = await padron.consultar(req.empresa, id);
    if (!persona) return res.status(404).json({ ok: false, error: `No se encontro ${id} en el padron de ARCA` });
    if (req.query.formato === 'hpm') {
      return res.type('text/plain; charset=utf-8').send(padron.aLineasHpm(persona));
    }
    res.json({ ok: true, persona });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
