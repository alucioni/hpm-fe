const express = require('express');
const router = express.Router();
const wsaa = require('../services/wsaa');
const tokenCache = require('../services/tokenCache');

router.post('/login', async (req, res, next) => {
  try {
    await tokenCache.clear(req.empresa.id);
    const { token, sign } = await wsaa.obtenerLoginTicketResponse(req.empresa);

    const [rows] = await require('../config/database').execute(
      'SELECT expires_at FROM token_cache WHERE empresa_id = ?',
      [req.empresa.id]
    );

    res.json({
      ok: true,
      token,
      sign,
      expira: rows[0]?.expires_at ?? null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
