const app = require('./app');
const config = require('./config');
const pool = require('./config/database');

async function start() {
  await pool.execute('SELECT 1');
  app.listen(config.port, config.host, () => {
    console.log(`HPM-FE corriendo en ${config.host}:${config.port}`);
  });
}

start().catch(err => {
  console.error('Error al iniciar:', err.message);
  process.exit(1);
});
