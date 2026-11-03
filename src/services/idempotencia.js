const pool = require('../config/database');

// Reclama la clave para esta emisión ANTES de llamar a AFIP.
//  - { estado: 'nuevo' }     → se insertó la fila 'en_curso', seguir con AFIP
//  - { estado: 'listo', datos } → ya se emitió antes con CAE, devolver esos datos
//  - { estado: 'en_curso' }  → otra request la está procesando ahora mismo
async function reclamar(empresaId, clave, ptoVta, tipoCbte) {
  try {
    await pool.execute(
      `INSERT INTO emisiones_idempotencia (empresa_id, clave, estado, punto_vta, tipo_cbte)
       VALUES (?, ?, 'en_curso', ?, ?)`,
      [empresaId, String(clave), ptoVta ?? null, tipoCbte ?? null]
    );
    return { estado: 'nuevo' };
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;

    const [rows] = await pool.execute(
      `SELECT estado, cae, vencimiento_cae, numero_comprobante, resultado
         FROM emisiones_idempotencia WHERE empresa_id = ? AND clave = ?`,
      [empresaId, String(clave)]
    );
    const row = rows[0];
    if (row && row.estado === 'listo') return { estado: 'listo', datos: row };
    return { estado: 'en_curso' };
  }
}

// AFIP devolvió CAE aprobado: fija la fila como 'listo'.
async function confirmar(empresaId, clave, result) {
  await pool.execute(
    `UPDATE emisiones_idempotencia
        SET estado = 'listo', cae = ?, vencimiento_cae = ?, numero_comprobante = ?, resultado = ?
      WHERE empresa_id = ? AND clave = ?`,
    [result.cae, result.vencimiento_cae, result.numero_comprobante, result.resultado, empresaId, String(clave)]
  );
}

// AFIP rechazó o la llamada falló: libera la clave para permitir el reintento.
async function liberar(empresaId, clave) {
  await pool.execute(
    `DELETE FROM emisiones_idempotencia
      WHERE empresa_id = ? AND clave = ? AND estado = 'en_curso'`,
    [empresaId, String(clave)]
  );
}

module.exports = { reclamar, confirmar, liberar };
