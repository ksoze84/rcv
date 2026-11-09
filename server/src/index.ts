import { createApp } from './http/app.js';
import { loadSafeEnvFile, readEnvironment } from './infrastructure/config/environment.js';
import { AuthAttemptGuard } from './infrastructure/sii/authAttemptGuard.js';
import { StagehandRcvProvider } from './infrastructure/sii/stagehandRcvProvider.js';

// Carga segura del entorno local sin registrar valores ni exponer secretos
loadSafeEnvFile();

const config = readEnvironment();
const authGuard = new AuthAttemptGuard(config.localStateDir);

const app = createApp(config, {
  authGuard,
  createProvider: (guard) => new StagehandRcvProvider(config, guard),
});

const server = app.listen(config.port, config.host, () => {
  console.log(`RCV Server escuchando en http://${config.host}:${config.port}`);
});

let isShuttingDown = false;
function handleShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Recibida señal ${signal}, cerrando servidor HTTP...`);
  server.close(() => {
    console.log('Servidor cerrado.');
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

