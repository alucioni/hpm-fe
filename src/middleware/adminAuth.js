const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');

// Acepta CUALQUIERA de las dos:
//  - header X-Admin-Secret (scripts / uso desde un túnel SSH, sin pasar por el SSO), o
//  - header Authorization: Bearer <jwt> emitido por tareas.hpm.ar (panel /admin en el
//    navegador) — se valida server-to-server contra /api/auth/verify y se exige rol admin.
module.exports = async function adminAuth(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (secret && config.adminSecret) {
    try {
      const provided = Buffer.from(secret);
      const expected = Buffer.from(config.adminSecret);
      if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
        return next();
      }
    } catch { /* cae a intentar el Bearer */ }
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: 'No autenticado' });

  try {
    const resp = await axios.post(
      config.tareasVerifyUrl,
      { token },
      { timeout: 8000, validateStatus: () => true }
    );
    if (resp.status !== 200 || !resp.data || !resp.data.valido) {
      return res.status(401).json({ ok: false, error: 'Sesión inválida o expirada' });
    }
    if (resp.data.usuario.rol !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Tu usuario no tiene rol admin en tareas.hpm.ar' });
    }
    req.adminUser = resp.data.usuario;
    next();
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'No se pudo validar la sesión: ' + err.message });
  }
};
