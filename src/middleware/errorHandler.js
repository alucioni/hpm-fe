const pool = require('../config/database');

module.exports = async function errorHandler(err, req, res, next) {
  if (req.empresa) {
    try {
      await pool.execute(
        'INSERT INTO facturas_log (empresa_id, endpoint, request, error) VALUES (?, ?, ?, ?)',
        [
          req.empresa.id,
          req.originalUrl.split('?')[0],
          JSON.stringify(req.body || null),
          err.message,
        ]
      );
    } catch {}
  }

  const tieneCodigoAfip = err.codigo_afip != null && !Number.isNaN(err.codigo_afip);
  const status = err.status || (tieneCodigoAfip ? statusAfip(err.codigo_afip) : 500);
  const body = { ok: false, error: err.message || 'Error interno del servidor' };
  if (tieneCodigoAfip) body.codigo_afip = err.codigo_afip;
  res.status(status).json(body);
};

// Un <Errors> de AFIP es un rechazo del pedido (punto de venta no habilitado, datos inválidos...):
// reintentar no sirve, así que va como 422 y HPM lo muestra como rechazo. Los códigos 5xx de AFIP
// son fallas internas de ellos, posiblemente transitorias: 502 para que HPM reintente.
function statusAfip(codigo) {
  return codigo >= 500 && codigo <= 599 ? 502 : 422;
}

module.exports.statusAfip = statusAfip;
