import { describe, it, expect } from 'vitest';
import { loadSafeEnvFile, readEnvironment, readSmokeCredentials } from './environment.js';

describe('loadSafeEnvFile', () => {
  it('no arroja error si el archivo no existe', () => {
    expect(() => loadSafeEnvFile('.nonexistent-env')).not.toThrow();
  });
});

describe('readEnvironment', () => {
  it('aplica defaults seguros de loopback y limites con entorno vacio', () => {
    const config = readEnvironment({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3001);
    expect(config.headless).toBe(true);
    expect(config.operationTimeoutMs).toBe(240000);
    expect(config.maxCsvBytes).toBe(10485760);
    expect(config.maxCsvRows).toBe(20000);
    expect(config.localStateDir).toBe('.local');
    expect(config.chromePath).toBeUndefined();
    expect(config.tabRenderTimeoutMs).toBe(25000);
  });

  it('permite sobrescribir host, puerto y opciones', () => {
    const config = readEnvironment({
      PORT: '8080',
      HOST: 'localhost',
      HEADLESS: 'false',
      OPERATION_TIMEOUT_MS: '60000',
      RCV_TAB_RENDER_TIMEOUT_MS: '30000',
      CHROME_PATH: '/custom/chrome',
      MAX_CSV_BYTES: '5242880',
      MAX_CSV_ROWS: '5000',
      LOCAL_STATE_DIR: '.custom_state',
    });
    expect(config.port).toBe(8080);
    expect(config.host).toBe('localhost');
    expect(config.headless).toBe(false);
    expect(config.operationTimeoutMs).toBe(60000);
    expect(config.tabRenderTimeoutMs).toBe(30000);
    expect(config.chromePath).toBe('/custom/chrome');
    expect(config.maxCsvBytes).toBe(5242880);
    expect(config.maxCsvRows).toBe(5000);
    expect(config.localStateDir).toBe('.custom_state');
  });

  it('rechaza host no seguro o no loopback', () => {
    expect(() => readEnvironment({ HOST: '0.0.0.0' })).toThrow(/HOST solo puede ser una interfaz loopback/);
    expect(() => readEnvironment({ HOST: '192.168.1.10' })).toThrow(/HOST solo puede ser una interfaz loopback/);
  });

  it('rechaza puerto inválido', () => {
    expect(() => readEnvironment({ PORT: '0' })).toThrow(/PORT debe ser un número entero entre 1 y 65535/);
    expect(() => readEnvironment({ PORT: '70000' })).toThrow(/PORT debe ser un número entero entre 1 y 65535/);
    expect(() => readEnvironment({ PORT: 'invalid' })).toThrow(/PORT debe ser un número entero entre 1 y 65535/);
  });
});

describe('readSmokeCredentials', () => {
  it('retorna null si faltan variables para tributaria', () => {
    const creds = readSmokeCredentials({}, 'tributaria');
    expect(creds).toBeNull();
  });

  it('lee credenciales tributaria cuando existen', () => {
    const creds = readSmokeCredentials(
      { TRIBUTARIA_USER: '11.111.111-1', TRIBUTARIA_PASS: 'secret' },
      'tributaria'
    );
    expect(creds).toEqual({ user: '11.111.111-1', pass: 'secret' });
  });

  it('soporta alias con typo TIBUTARIA_USER para tributaria', () => {
    const creds = readSmokeCredentials(
      { TIBUTARIA_USER: '22.222.222-2', TRIBUTARIA_PASS: 'secret-typo' },
      'tributaria'
    );
    expect(creds).toEqual({ user: '22.222.222-2', pass: 'secret-typo' });
  });

  it('lee credenciales clave unica cuando existen', () => {
    const creds = readSmokeCredentials(
      { CLAVE_UNICA_USER: '33.333.333-3', CLAVE_UNICA_PASS: 'clave-secreta' },
      'clave-unica'
    );
    expect(creds).toEqual({ user: '33.333.333-3', pass: 'clave-secreta' });
  });

  it('retorna null para clave unica si falta contrasena', () => {
    const creds = readSmokeCredentials(
      { CLAVE_UNICA_USER: '33.333.333-3' },
      'clave-unica'
    );
    expect(creds).toBeNull();
  });
});
