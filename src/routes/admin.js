const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const pool = require('../config/database');
const { encryptPassword, decryptPassword, getCertInfo } = require('../services/crypto');
const tokenCache = require('../services/tokenCache');
const validate = require('../middleware/validate');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 },
  fileFilter: (req, file, cb) => {
    const valid = file.originalname.toLowerCase().endsWith('.p12')
      || file.mimetype === 'application/x-pkcs12'
      || file.mimetype === 'application/octet-stream';
    cb(valid ? null : new Error('Solo se aceptan archivos .p12'), valid);
  },
});

// Una empresa "tiene emisiones" si algún comprobante obtuvo CAE. Los intentos fallidos o
// rechazados no cuentan: con un CUIT mal cargado es justamente lo esperable.
async function tieneEmisiones(empresaId) {
  const [[row]] = await pool.execute(
    "SELECT COUNT(*) AS n FROM facturas_log WHERE empresa_id = ? AND cae IS NOT NULL AND cae <> ''",
    [empresaId]
  );
  return row.n > 0;
}

router.get('/empresas', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, cuit, razon_social, activo, p12_data, p12_password_encrypted, created_at FROM empresas ORDER BY id'
    );

    const empresas = await Promise.all(rows.map(async (e) => {
      let p12_vencimiento = null;
      let p12_error = null;
      try {
        const password = decryptPassword(e.p12_password_encrypted);
        const info = getCertInfo(e.p12_data, password);
        p12_vencimiento = info.validTo;
      } catch (err) {
        p12_error = 'No se pudo leer el certificado (' + err.message + ')';
      }
      let ultima_emision = null;
      try {
        const [[log]] = await pool.execute(
          "SELECT created_at, cae, resultado FROM facturas_log WHERE empresa_id = ? AND endpoint LIKE '%/emitir' ORDER BY id DESC LIMIT 1",
          [e.id]
        );
        ultima_emision = log || null;
      } catch { /* opcional, no bloquea el listado */ }
      let tiene_emisiones = null;
      try {
        tiene_emisiones = await tieneEmisiones(e.id);
      } catch { /* opcional, no bloquea el listado */ }

      return {
        id: e.id,
        cuit: e.cuit,
        razon_social: e.razon_social,
        activo: !!e.activo,
        created_at: e.created_at,
        p12_vencimiento,
        p12_error,
        ultima_emision,
        tiene_emisiones,
      };
    }));

    res.json({ ok: true, empresas });
  } catch (err) {
    next(err);
  }
});

router.post('/empresas', upload.single('p12'), async (req, res, next) => {
  try {
    const { cuit, razon_social, p12_password } = req.body;

    if (!cuit || !razon_social || !p12_password) {
      return res.status(422).json({ ok: false, error: 'cuit, razon_social y p12_password son requeridos' });
    }
    if (!req.file) {
      return res.status(422).json({ ok: false, error: 'Archivo .p12 requerido' });
    }

    const apiKey = crypto.randomBytes(32).toString('hex');
    const passwordEncrypted = encryptPassword(p12_password);

    const [result] = await pool.execute(
      'INSERT INTO empresas (cuit, razon_social, p12_data, p12_password_encrypted, api_key) VALUES (?, ?, ?, ?, ?)',
      [cuit, razon_social, req.file.buffer, passwordEncrypted, apiKey]
    );

    res.json({ ok: true, empresa_id: result.insertId, api_key: apiKey });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(422).json({ ok: false, error: 'El CUIT ya está registrado' });
    }
    next(err);
  }
});

router.put('/empresas/:id/certificado', upload.single('p12'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { p12_password } = req.body;

    if (!p12_password) {
      return res.status(422).json({ ok: false, error: 'p12_password es requerido' });
    }
    if (!req.file) {
      return res.status(422).json({ ok: false, error: 'Archivo .p12 requerido' });
    }

    const passwordEncrypted = encryptPassword(p12_password);

    const [result] = await pool.execute(
      'UPDATE empresas SET p12_data = ?, p12_password_encrypted = ? WHERE id = ?',
      [req.file.buffer, passwordEncrypted, id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ ok: false, error: 'Empresa no encontrada' });
    }

    await tokenCache.clear(id);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.patch('/empresas/:id', validate('patchEmpresa'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { activo, razon_social, cuit } = req.body;

    if (cuit !== undefined && await tieneEmisiones(id)) {
      return res.status(422).json({ ok: false, error: 'No se puede cambiar el CUIT: la empresa ya tiene comprobantes emitidos con CAE' });
    }

    const sets = [];
    const params = [];
    if (activo !== undefined) { sets.push('activo = ?'); params.push(activo); }
    if (razon_social !== undefined) { sets.push('razon_social = ?'); params.push(razon_social); }
    if (cuit !== undefined) { sets.push('cuit = ?'); params.push(cuit); }
    params.push(id);

    const [result] = await pool.execute(
      `UPDATE empresas SET ${sets.join(', ')} WHERE id = ?`,
      params
    );

    if (!result.affectedRows) {
      return res.status(404).json({ ok: false, error: 'Empresa no encontrada' });
    }

    // El ticket WSAA cacheado se pidió para el CUIT anterior.
    if (cuit !== undefined) await tokenCache.clear(id);

    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(422).json({ ok: false, error: 'El CUIT ya está registrado en otra empresa' });
    }
    next(err);
  }
});

module.exports = router;
