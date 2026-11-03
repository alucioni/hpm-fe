const crypto = require('crypto');
const config = require('../config');

// Autenticación de HPM: una única API Key global (HPM_API_KEY del .env), comparada en
// tiempo constante. La empresa emisora NO se resuelve acá — va por `cuit_emisor` en el
// body/query (ver middleware/resolveEmpresa.js).
module.exports = function auth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'API Key requerida' });
  }

  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(config.hpmApiKey || '');

  if (!config.hpmApiKey || provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return res.status(401).json({ ok: false, error: 'API Key inválida' });
  }

  next();
};
