import fs from 'node:fs';
import { AuthMode } from '../../../../shared/rcv.js';

export interface AppConfig {
  port: number;
  host: string;
  localStateDir: string;
  chromePath?: string;
  headless: boolean;
  operationTimeoutMs: number;
  maxCsvBytes: number;
  maxCsvRows: number;
  tabRenderTimeoutMs?: number;
}

export interface SmokeCredentials {
  user: string;
  pass: string;
}

/**
 * Carga de forma segura un archivo .env local si existe, sin exponer
 * secretos ni registrar valores en consola.
 */
export function loadSafeEnvFile(filePath = '.env'): void {
  try {
    if (typeof process.loadEnvFile === 'function' && fs.existsSync(filePath)) {
      process.loadEnvFile(filePath);
    }
  } catch {
    // Falla de forma silenciosa y segura si el archivo no existe o no tiene permisos
  }
}

/**
 * Lee la configuracion operativa del entorno sin publicar ni leer credenciales tributarias.
 */
export function readEnvironment(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number.parseInt(env.PORT || '3001', 10);
  const host = env.HOST || '127.0.0.1';

  // Validaciones estrictas de seguridad:
  // 1. Host debe ser loopback estricto (127.0.0.1 o localhost) para evitar exposición de red
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('Configuración inválida: HOST solo puede ser una interfaz loopback local (127.0.0.1 o localhost).');
  }

  // 2. Puerto debe estar en rango válido 1..65535
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error('Configuración inválida: PORT debe ser un número entero entre 1 y 65535.');
  }
  const localStateDir = env.LOCAL_STATE_DIR || '.local';
  const chromePath = env.CHROME_PATH && env.CHROME_PATH.trim().length > 0 ? env.CHROME_PATH.trim() : undefined;
  const headless = env.HEADLESS !== 'false';
  const operationTimeoutMs = Number.parseInt(env.OPERATION_TIMEOUT_MS || '240000', 10);
  const maxCsvBytes = Number.parseInt(env.MAX_CSV_BYTES || '10485760', 10); // 10 MiB por defecto
  const maxCsvRows = Number.parseInt(env.MAX_CSV_ROWS || '20000', 10);
  const rawTabRenderTimeout = Number.parseInt(env.RCV_TAB_RENDER_TIMEOUT_MS || env.TAB_RENDER_TIMEOUT_MS || '25000', 10);
  const tabRenderTimeoutMs = Number.isFinite(rawTabRenderTimeout) && rawTabRenderTimeout > 0 ? rawTabRenderTimeout : 25000;

  const config: AppConfig = {
    port: Number.isFinite(port) && port > 0 ? port : 3001,
    host,
    localStateDir,
    headless,
    operationTimeoutMs: Number.isFinite(operationTimeoutMs) && operationTimeoutMs > 0 ? operationTimeoutMs : 240000,
    maxCsvBytes: Number.isFinite(maxCsvBytes) && maxCsvBytes > 0 ? maxCsvBytes : 10485760,
    maxCsvRows: Number.isFinite(maxCsvRows) && maxCsvRows > 0 ? maxCsvRows : 20000,
    tabRenderTimeoutMs,
  };

  if (chromePath) {
    config.chromePath = chromePath;
  }

  return config;
}

/**
 * Lee credenciales EXCLUSIVAMENTE para pruebas de smoke controladas.
 * Soporta el alias 'TIBUTARIA_USER' por compatibilidad con configuraciones previas.
 * No debe ser utilizado en la aplicacion regular ni expuesto al frontend.
 */
export function readSmokeCredentials(
  env: NodeJS.ProcessEnv = process.env,
  authMode: AuthMode = 'tributaria'
): SmokeCredentials | null {
  if (authMode === 'clave-unica') {
    const user = env.CLAVE_UNICA_USER?.trim();
    const pass = env.CLAVE_UNICA_PASS;
    if (user && pass) {
      return { user, pass };
    }
    return null;
  }

  if (authMode === 'tributaria') {
    // Soporta TRIBUTARIA_USER y el alias con errata TIBUTARIA_USER
    const user = (env.TRIBUTARIA_USER || env.TIBUTARIA_USER)?.trim();
    const pass = env.TRIBUTARIA_PASS;
    if (user && pass) {
      return { user, pass };
    }
    return null;
  }

  return null;
}
