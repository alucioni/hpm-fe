// Utilidades compartidas por la suite de tests.
// No requiere la DB ni levanta el server hasta que se llama explícitamente,
// así los tests unitarios corren sin WAMP/MySQL ni conexión a AFIP.

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const config = require('../src/config');

// Respuesta Express mínima para probar middlewares en aislamiento.
function fakeRes() {
  const res = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; res.headersSent = true; return res; };
  res.set = () => res;
  res.setHeader = () => res;
  res.getHeader = () => undefined;
  res.end = () => { res.headersSent = true; return res; };
  return res;
}

// Corre un middleware `(req, res, next)` y resuelve cuando llama a next() o responde.
function runMiddleware(mw, req) {
  const res = fakeRes();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      if (err) return reject(err);
      resolve({ req, res });
    };
    const next = (err) => finish(err);
    // Interceptamos json() para resolver también cuando el middleware responde directo.
    const origJson = res.json;
    res.json = (payload) => { origJson(payload); finish(); return res; };
    try {
      const maybe = mw(req, res, next);
      if (maybe && typeof maybe.then === 'function') maybe.catch(finish);
    } catch (e) {
      finish(e);
    }
  });
}

let pool;
function db() {
  if (!pool) pool = require('../src/config/database');
  return pool;
}

async function dbUp() {
  try {
    await db().execute('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function closeDb() {
  if (pool) {
    try { await pool.end(); } catch {}
    pool = undefined;
  }
}

let server;
async function startApp() {
  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function stopApp() {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
  }
}

// fetch helper: devuelve { status, body } con body ya parseado como JSON si se puede.
async function req(baseUrl, method, path, { body, headers } = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const AUTH = () => ({ Authorization: `Bearer ${config.hpmApiKey}` });

module.exports = {
  config,
  fakeRes,
  runMiddleware,
  db,
  dbUp,
  closeDb,
  startApp,
  stopApp,
  req,
  delay,
  AUTH,
};
