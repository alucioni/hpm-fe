require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  db: {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  },
  afip: {
    url: process.env.AFIP_URL,
    wsaaUrl: process.env.WSAA_URL,
    padronA4Url: process.env.PADRON_A4_URL || 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA4',
  },
  // Empresa (cargada en /admin con su .p12) cuyo certificado se usa para TODAS las consultas
  // de padron: ARCA deja consultar cualquier CUIT con un solo certificado autorizado para
  // ws_sr_padron_a4. Asi las PC de HPM no necesitan certificado propio.
  padronCuit: process.env.PADRON_CUIT || '20219547006',
  p12EncryptionKey: process.env.P12_ENCRYPTION_KEY,
  adminSecret: process.env.ADMIN_SECRET,
  hpmApiKey: process.env.HPM_API_KEY,
  // URL pública con la que HPM llega a este servidor (FE_API_URL en la configuración de HPM).
  publicUrl: process.env.PUBLIC_URL || 'https://fe.hpm.ar',
  rateLimitRps: parseInt(process.env.RATE_LIMIT_RPS || '5', 10),
  // Panel /admin: "módulo consumidor" del SSO de la plataforma hpm.ar. No hay login propio;
  // se redirige a hpm.ar/login.html y el token (JWT emitido por tareas.hpm.ar) se valida acá
  // server-to-server contra /api/auth/verify. Ver docs/superpowers/specs SSO de hpm_tareas.
  hpmLoginUrl: process.env.HPM_LOGIN_URL || 'https://hpm.ar/login.html',
  tareasVerifyUrl: process.env.TAREAS_VERIFY_URL || 'https://tareas.hpm.ar/api/auth/verify',
};
