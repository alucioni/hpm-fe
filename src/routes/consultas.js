const express = require('express');
const router = express.Router();
const wsfev1 = require('../services/wsfev1');
const pool = require('../config/database');

router.get('/dummy', async (req, res, next) => {
  try {
    const result = await wsfev1.FEDummy();
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.get('/health', async (req, res, next) => {
  try {
    await pool.execute('SELECT 1');
    res.json({ ok: true, uptime: Math.floor(process.uptime()), db: 'connected' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
