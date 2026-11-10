const express = require('express');
const path = require('path');
const config = require('./config');
const app = express();

app.use(express.json());

// Panel de administración (alta de empresas / certificados). "Módulo consumidor" del SSO
// de hpm.ar: no tiene login propio, sólo lee el token que le pasan por query string tras
// pasar por hpm.ar/login.html (ver docs SSO de hpm_tareas). El HTML no tiene ningún secreto.
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// Valores FE_API_KEY / FE_API_URL para copiar a la configuración de HPM. Pública a pedido
// (sin login): cualquiera que abra la página ve la API key.
app.get('/configuracion.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'configuracion.html'));
});
app.get('/configuracion.json', (req, res) => {
  res.json({
    ok: true,
    configuracion: [
      { clave: 'FE_API_KEY', valor: config.hpmApiKey || '' },
      { clave: 'FE_API_URL', valor: config.publicUrl },
    ],
  });
});

// Archivos para instalar en los clientes (ej. whatsapp.zip del servicio WhatsApp de HPM).
// La carpeta descargas/ no está en git: los archivos se suben directo al servidor.
app.use('/descargas', express.static(path.join(__dirname, '..', 'descargas'), { index: false }));

const auth = require('./middleware/auth');
const adminAuth = require('./middleware/adminAuth');
const resolveEmpresa = require('./middleware/resolveEmpresa');
const rateLimitMiddleware = require('./middleware/rateLimit');
const errorHandler = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth');
const facturaRoutes = require('./routes/factura');
const consultasRoutes = require('./routes/consultas');
const parametrosRoutes = require('./routes/parametros');
const adminRoutes = require('./routes/admin');
const padronRoutes = require('./routes/padron');
const resolvePadronEmpresa = require('./middleware/resolvePadronEmpresa');

// Rutas admin: header X-Admin-Secret (scripts) o Authorization: Bearer <jwt de tareas.hpm.ar>
app.use('/api/v1/admin', adminAuth, adminRoutes);

// Rutas que operan sobre una empresa emisora: API Key + resolución por cuit_emisor + rate limit
const empresaMiddleware = [auth, resolveEmpresa, rateLimitMiddleware];
app.use('/api/v1/auth', empresaMiddleware, authRoutes);
app.use('/api/v1/factura', empresaMiddleware, facturaRoutes);
app.use('/api/v1/parametros', empresaMiddleware, parametrosRoutes);

// Padron ARCA: API Key + certificado central (PADRON_CUIT), no el de la empresa que factura
app.use('/api/v1/padron', [auth, rateLimitMiddleware, resolvePadronEmpresa], padronRoutes);

// Estado / salud: sólo API Key (no requieren empresa)
app.use('/api/v1', [auth, rateLimitMiddleware], consultasRoutes);

app.use(errorHandler);

module.exports = app;
