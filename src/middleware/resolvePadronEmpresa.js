const pool = require('../config/database');
const config = require('../config');

// Las consultas de padron no dependen de la empresa que factura: siempre usan el certificado
// de la empresa PADRON_CUIT (ver config). Se adjunta como req.empresa, igual que resolveEmpresa.
module.exports = async function resolvePadronEmpresa(req, res, next) {
  try {
    const [rows] = await pool.execute(
      'SELECT id, cuit, razon_social, p12_data, p12_password_encrypted, activo FROM empresas WHERE cuit = ?',
      [config.padronCuit]
    );

    if (!rows.length || !rows[0].activo) {
      return res.status(503).json({
        ok: false,
        error: `Consulta de padron no configurada: falta cargar en /admin la empresa ${config.padronCuit} con su certificado`,
      });
    }

    req.empresa = rows[0];
    next();
  } catch (err) {
    next(err);
  }
};
