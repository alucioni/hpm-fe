const pool = require('../config/database');

// expires_at se guarda en UTC (pool con timezone '+00:00'): comparar contra UTC_TIMESTAMP(),
// no NOW(), que da la hora local del servidor (-03) y dejaba usar el token ~3 h vencido.
async function get(empresaId) {
  const [rows] = await pool.execute(
    `SELECT token, sign, expires_at FROM token_cache
     WHERE empresa_id = ? AND expires_at > DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE)`,
    [empresaId]
  );
  return rows[0] || null;
}

async function set(empresaId, token, sign, expiresAt) {
  await pool.execute(
    `INSERT INTO token_cache (empresa_id, token, sign, expires_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE token = VALUES(token), sign = VALUES(sign), expires_at = VALUES(expires_at)`,
    [empresaId, token, sign, expiresAt]
  );
}

async function clear(empresaId) {
  await pool.execute('DELETE FROM token_cache WHERE empresa_id = ?', [empresaId]);
}

// Tokens de otros servicios WSAA (ws_sr_padron_a4...): tabla aparte, ver migracion 003.
async function getServicio(empresaId, servicio) {
  const [rows] = await pool.execute(
    `SELECT token, sign, expires_at FROM token_cache_servicio
     WHERE empresa_id = ? AND servicio = ? AND expires_at > DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE)`,
    [empresaId, servicio]
  );
  return rows[0] || null;
}

async function setServicio(empresaId, servicio, token, sign, expiresAt) {
  await pool.execute(
    `INSERT INTO token_cache_servicio (empresa_id, servicio, token, sign, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE token = VALUES(token), sign = VALUES(sign), expires_at = VALUES(expires_at)`,
    [empresaId, servicio, token, sign, expiresAt]
  );
}

module.exports = { get, set, clear, getServicio, setServicio };
