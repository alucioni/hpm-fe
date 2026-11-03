const pool = require('../config/database');

// Resuelve la empresa emisora por `cuit_emisor` (body en POST, query en GET) y la adjunta
// como req.empresa. Reemplaza a la resolución por API Key: ahora una sola API Key puede
// emitir por cualquier CUIT cargado (ver docs del proyecto).
module.exports = async function resolveEmpresa(req, res, next) {
  const cuit = String((req.body && req.body.cuit_emisor) || (req.query && req.query.cuit_emisor) || '').trim();

  if (!/^\d{11}$/.test(cuit)) {
    return res.status(422).json({ ok: false, error: 'cuit_emisor requerido (11 dígitos)' });
  }

  try {
    const [rows] = await pool.execute(
      'SELECT id, cuit, razon_social, p12_data, p12_password_encrypted, activo FROM empresas WHERE cuit = ?',
      [cuit]
    );

    if (!rows.length || !rows[0].activo) {
      return res.status(422).json({ ok: false, error: 'CUIT emisor no registrado o inactivo' });
    }

    req.empresa = rows[0];
    next();
  } catch (err) {
    next(err);
  }
};
