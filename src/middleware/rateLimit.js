const rateLimit = require('express-rate-limit');
const config = require('../config');

module.exports = rateLimit({
  windowMs: 1000,
  max: config.rateLimitRps,
  keyGenerator: (req) => (req.empresa && req.empresa.id ? String(req.empresa.id) : 'global'),
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'Rate limit excedido' });
  },
  standardHeaders: false,
  legacyHeaders: false,
});
