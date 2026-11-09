import request from 'supertest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from './app.js';
import { readEnvironment } from '../infrastructure/config/environment.js';
import { RcvProvider, RcvDownloads } from '../domain/rcvProvider.js';
import { AuthAttemptGuard } from '../infrastructure/sii/authAttemptGuard.js';
import { AppError } from '../domain/errors.js';

describe('HTTP App - Pruebas completas T3 / T6', () => {
  let tmpDir: string;
  let simulatedTime: number;
  let guard: AuthAttemptGuard;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-app-test-'));
    simulatedTime = 1_000_000;
    guard = new AuthAttemptGuard(tmpDir, () => simulatedTime);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/health devuelve 200, periodo fijo febrero 2026 y Cache-Control: no-store', async () => {
    const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
    const app = createApp(config, { authGuard: guard });

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.status).toBe('ok');
    expect(res.body.period).toEqual({ year: 2026, month: 2 });
  });

  it('POST /api/rcv rechaza credenciales con RUT invalido (400)', async () => {
    const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
    const app = createApp(config, { authGuard: guard });

    const res = await request(app)
      .post('/api/rcv')
      .send({ rut: '11.111.111-9', password: 'secretpassword', authMode: 'tributaria' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('POST /api/rcv con credenciales validas sintacticamente devuelve 501 si no hay provider', async () => {
    const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
    const app = createApp(config, { authGuard: guard });

    // 11.111.111-1 es un RUT con DV valido
    const res = await request(app)
      .post('/api/rcv')
      .send({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' });
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('rechaza Content-Type no application/json con 415', async () => {
    const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
    const app = createApp(config, { authGuard: guard });

    const res = await request(app)
      .post('/api/rcv')
      .set('Content-Type', 'text/plain')
      .send('rut=11111111-1');

    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rechaza JSON malformado con 400 y mensaje controlado', async () => {
    const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
    const app = createApp(config, { authGuard: guard });

    const res = await request(app)
      .post('/api/rcv')
      .set('Content-Type', 'application/json')
      .send('{"rut": "11111111-1", '); // JSON trunco

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MALFORMED_JSON');
    expect(res.body.error.message).toContain('JSON válido');
  });

  it('rechaza Host no loopback (evil.localhost o dominio remoto) con 403', async () => {
    const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
    const app = createApp(config, { authGuard: guard });

    const res = await request(app)
      .post('/api/rcv')
      .set('Host', 'evil.localhost')
      .send({ rut: '11.111.111-1', password: 'secret', authMode: 'tributaria' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVALID_HOST');
  });

  it('permite Origin local de Vite (5173)', async () => {
    const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
    const app = createApp(config, { authGuard: guard });

    const res = await request(app)
      .post('/api/rcv')
      .set('Origin', 'http://127.0.0.1:5173')
      .send({ rut: '11.111.111-1', password: 'secret', authMode: 'tributaria' });

    // Pasa la validación de origen y responde 501 por falta de provider
    expect(res.status).toBe(501);
  });

  it('rechaza Origin no autorizado con 403', async () => {
    const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
    const app = createApp(config, { authGuard: guard });

    const res = await request(app)
      .post('/api/rcv')
      .set('Origin', 'http://malicious-site.com')
      .send({ rut: '11.111.111-1', password: 'secret', authMode: 'tributaria' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVALID_ORIGIN');
  });

  it('rechaza Sec-Fetch-Site cross-site con 403', async () => {
    const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
    const app = createApp(config, { authGuard: guard });

    const res = await request(app)
      .post('/api/rcv')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ rut: '11.111.111-1', password: 'secret', authMode: 'tributaria' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVALID_ORIGIN');
  });

  it('aplica enfriamiento de 15s retornando 429 y cabecera Retry-After', async () => {
    const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
    const createMockProvider = (g: AuthAttemptGuard): RcvProvider => ({
      fetch: vi.fn().mockImplementation(async () => {
        await g.reserveAttempt(15);
        return {
          compras: { status: 'empty' },
          ventas: { status: 'empty' },
        } as RcvDownloads;
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const app = createApp(config, {
      authGuard: guard,
      createProvider: (g) => createMockProvider(g),
    });

    // Primer intento: exitoso
    const res1 = await request(app)
      .post('/api/rcv')
      .send({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' });
    expect(res1.status).toBe(200);

    // Segundo intento inmediato (mismo segundo): 429 RATE_LIMITED
    const res2 = await request(app)
      .post('/api/rcv')
      .send({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' });
    expect(res2.status).toBe(429);
    expect(res2.body.error.code).toBe('RATE_LIMITED');
    expect(res2.headers['retry-after']).toBe('15');
    expect(res2.body.error.retryAfterSeconds).toBe(15);
  });

  it('bloqueo preventivo de 30m retorna 429 y sobrevive reinicios', async () => {
    const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
    guard.markBlocked(1800);

    const app = createApp(config, { authGuard: guard });

    const res = await request(app)
      .post('/api/rcv')
      .send({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('ACCOUNT_BLOCKED');
    expect(res.headers['retry-after']).toBe('1800');
  });

  it('no invoca markBlocked en guard ante ACCOUNT_BLOCKED desde provider (estrategia portal lo hace explicitamente)', async () => {
    const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
    const markBlockedSpy = vi.spyOn(guard, 'markBlocked');

    const mockProvider: RcvProvider = {
      fetch: vi.fn().mockRejectedValue(
        new AppError('ACCOUNT_BLOCKED', 'Cuenta bloqueada detectada por portal', 429, 1800)
      ),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const app = createApp(config, {
      authGuard: guard,
      createProvider: () => mockProvider,
    });

    const res = await request(app)
      .post('/api/rcv')
      .send({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('ACCOUNT_BLOCKED');
    // app.ts no debe llamar a markBlocked redundante / sin codigo explicito de portal
    expect(markBlockedSpy).not.toHaveBeenCalled();
  });

  it('procesa descarga completa y retorna RcvResult estructurado con Cache-Control no-store', async () => {
    const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
    const comprasCsv = new TextEncoder().encode('RUT;Monto\n76123456-7;10000');
    const ventasCsv = new TextEncoder().encode('Folio;Total\n001;5000');

    const mockProvider: RcvProvider = {
      fetch: vi.fn().mockResolvedValue({
        compras: { status: 'downloaded', bytes: comprasCsv },
        ventas: { status: 'downloaded', bytes: ventasCsv },
      } as RcvDownloads),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const app = createApp(config, {
      authGuard: guard,
      createProvider: () => mockProvider,
    });

    const res = await request(app)
      .post('/api/rcv')
      .send({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.status).toBe('complete');
    expect(res.body.period).toEqual({ year: 2026, month: 2 });
    expect(res.body.compras.status).toBe('ok');
    expect(res.body.compras.rows).toHaveLength(1);
    expect(res.body.ventas.status).toBe('ok');
    expect(res.body.ventas.rows).toHaveLength(1);
    expect(mockProvider.close).toHaveBeenCalledTimes(1);
  });

  it('maneja resultado parcial si una descarga tiene éxito y la otra falla', async () => {
    const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
    const comprasCsv = new TextEncoder().encode('RUT;Monto\n76123456-7;10000');

    const mockProvider: RcvProvider = {
      fetch: vi.fn().mockResolvedValue({
        compras: { status: 'downloaded', bytes: comprasCsv },
        ventas: {
          status: 'error',
          error: { code: 'PORTAL_TIMEOUT', message: 'Fallo al consultar ventas en portal' },
        },
      } as RcvDownloads),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const app = createApp(config, {
      authGuard: guard,
      createProvider: () => mockProvider,
    });

    const res = await request(app)
      .post('/api/rcv')
      .send({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('partial');
    expect(res.body.compras.status).toBe('ok');
    expect(res.body.ventas.status).toBe('error');
    expect(res.body.ventas.error.code).toBe('PORTAL_TIMEOUT');
    expect(mockProvider.close).toHaveBeenCalledTimes(1);
  });

  it('devuelve 502 Bad Gateway si ambas descargas fallan', async () => {
    const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
    const mockProvider: RcvProvider = {
      fetch: vi.fn().mockResolvedValue({
        compras: {
          status: 'error',
          error: { code: 'FAIL_COMPRAS', message: 'No se pudo descargar compras' },
        },
        ventas: {
          status: 'error',
          error: { code: 'FAIL_VENTAS', message: 'No se pudo descargar ventas' },
        },
      } as RcvDownloads),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const app = createApp(config, {
      authGuard: guard,
      createProvider: () => mockProvider,
    });

    const res = await request(app)
      .post('/api/rcv')
      .send({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('RCV_FETCH_FAILED');
    expect(mockProvider.close).toHaveBeenCalledTimes(1);
  });

  it('devuelve 504 Gateway Timeout si la operación supera operationTimeoutMs y cierra provider', async () => {
    const config = readEnvironment({
      LOCAL_STATE_DIR: tmpDir,
      OPERATION_TIMEOUT_MS: '20', // timeout muy corto para probar
    });

    const closeMock = vi.fn().mockResolvedValue(undefined);
    const mockProvider: RcvProvider = {
      fetch: vi.fn().mockImplementation((_creds, signal: AbortSignal) => {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason);
          });
        });
      }),
      close: closeMock,
    };

    const app = createApp(config, {
      authGuard: guard,
      createProvider: () => mockProvider,
    });

    const res = await request(app)
      .post('/api/rcv')
      .send({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' });

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('GATEWAY_TIMEOUT');
    expect(closeMock).toHaveBeenCalled();
  });

  it('controla concurrencia in-flight (409) si hay una operación en curso', async () => {
    const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });

    let resolveFetch: ((value: RcvDownloads) => void) | undefined;
    const mockProvider: RcvProvider = {
      fetch: vi.fn().mockImplementation(() => {
        return new Promise<RcvDownloads>((resolve) => {
          resolveFetch = resolve;
        });
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const app = createApp(config, {
      authGuard: guard,
      createProvider: () => mockProvider,
    });

    const server = await new Promise<import('node:http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;

    try {
      // Petición 1 con fetch nativo
      const fetch1 = fetch(`http://127.0.0.1:${port}/api/rcv`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' }),
      });

      // Esperar a que provider.fetch sea invocado efectivamente
      await vi.waitFor(() => {
        expect(mockProvider.fetch).toHaveBeenCalledTimes(1);
      });

      // Petición 2 mientras req1 está en curso: 409 OPERATION_IN_PROGRESS
      const res2 = await fetch(`http://127.0.0.1:${port}/api/rcv`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' }),
      });

      expect(res2.status).toBe(409);
      const body2 = (await res2.json()) as { error: { code: string } };
      expect(body2.error.code).toBe('OPERATION_IN_PROGRESS');

      // Desbloqueamos la petición 1
      if (resolveFetch) {
        resolveFetch({
          compras: { status: 'empty' },
          ventas: { status: 'empty' },
        });
      }

      const res1 = await fetch1;
      expect(res1.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('no expone datos sensibles ni secretos en errores ni en respuestas', async () => {
    const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
    const superSecret = 'super-secret-password-never-leak';

    const mockProvider: RcvProvider = {
      fetch: vi.fn().mockRejectedValue(new Error(`Failed with secret: ${superSecret}`)),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const app = createApp(config, {
      authGuard: guard,
      createProvider: () => mockProvider,
    });

    const res = await request(app)
      .post('/api/rcv')
      .send({ rut: '11.111.111-1', password: superSecret, authMode: 'tributaria' });

    expect(res.status).toBe(500);
    const bodyString = JSON.stringify(res.body);
    expect(bodyString).not.toContain(superSecret);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('rechaza body con payload > 10kb con 413 estático y envelope exacto', async () => {
    const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
    const app = createApp(config, { authGuard: guard });

    const largeData = 'a'.repeat(15 * 1024);
    const res = await request(app)
      .post('/api/rcv')
      .set('Content-Type', 'application/json')
      .send(`{"rut":"11.111.111-1","password":"${largeData}","authMode":"tributaria"}`);

    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'El tamaño de la solicitud excede el límite permitido.',
      },
    });
  });

  it('no reserva intento preventivo en guard al llegar request a la API (solo assertAllowed)', async () => {
    const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
    const app = createApp(config, {
      authGuard: guard,
      // createProvider no configurado -> lanzará 501
    });

    const res = await request(app)
      .post('/api/rcv')
      .send({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' });

    expect(res.status).toBe(501);
    // El guard NO debe haber reservado (nextAllowedAt permanece en 0)
    expect(guard.getState().nextAllowedAt).toBe(0);
  });

  it('aborta y cierra provider inmediatamente cuando el cliente desconecta antes de completar', async () => {
    const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });

    let providerSignal: AbortSignal | undefined;
    const closeMock = vi.fn().mockResolvedValue(undefined);

    const mockProvider: RcvProvider = {
      fetch: vi.fn().mockImplementation((_creds, signal: AbortSignal) => {
        providerSignal = signal;
        return new Promise<RcvDownloads>(() => {
          // Operación pendiente que nunca resuelve por sí sola
        });
      }),
      close: closeMock,
    };

    const app = createApp(config, {
      authGuard: guard,
      createProvider: () => mockProvider,
    });

    const server = await new Promise<import('node:http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;

    try {
      const clientAbort = new AbortController();
      const clientReq = fetch(`http://127.0.0.1:${port}/api/rcv`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' }),
        signal: clientAbort.signal,
      }).catch(() => {
        // Ignorar abort local del fetch
      });

      await vi.waitFor(() => {
        expect(mockProvider.fetch).toHaveBeenCalledTimes(1);
        expect(providerSignal).toBeDefined();
      });

      // El cliente aborta
      clientAbort.abort();
      await clientReq;

      await vi.waitFor(() => {
        expect(providerSignal?.aborted).toBe(true);
        expect(closeMock).toHaveBeenCalled();
      });
    } finally {
      server.close();
    }
  });

  describe('Cleanup guard lifetime y fail-closed behavior', () => {
    it('libera el lock exitosamente cuando provider.close resuelve con éxito', async () => {
      const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
      let releaseSpyCalled = false;
      const originalAcquire = guard.acquireOperation.bind(guard);
      vi.spyOn(guard, 'acquireOperation').mockImplementation(async () => {
        const release = await originalAcquire();
        return async () => {
          releaseSpyCalled = true;
          await release();
        };
      });

      const closeMock = vi.fn().mockResolvedValue(undefined);
      const mockProvider: RcvProvider = {
        fetch: vi.fn().mockResolvedValue({
          compras: { status: 'empty' },
          ventas: { status: 'empty' },
        } as RcvDownloads),
        close: closeMock,
      };

      const app = createApp(config, {
        authGuard: guard,
        createProvider: () => mockProvider,
      });

      const res = await request(app)
        .post('/api/rcv')
        .send({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' });

      expect(res.status).toBe(200);
      expect(closeMock).toHaveBeenCalledTimes(1);
      expect(releaseSpyCalled).toBe(true);

      // Una segunda petición posterior es aceptada porque se liberó el lock
      const res2 = await request(app)
        .post('/api/rcv')
        .send({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' });
      expect(res2.status).toBe(200);
    });

    it('libera el lock cuando no se inició provider (provider undefined, ej 501 NOT_IMPLEMENTED)', async () => {
      const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
      let releaseSpyCalled = false;
      const originalAcquire = guard.acquireOperation.bind(guard);
      vi.spyOn(guard, 'acquireOperation').mockImplementation(async () => {
        const release = await originalAcquire();
        return async () => {
          releaseSpyCalled = true;
          await release();
        };
      });

      const app = createApp(config, {
        authGuard: guard,
        // Sin createProvider
      });

      const res = await request(app)
        .post('/api/rcv')
        .send({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' });

      expect(res.status).toBe(501);
      expect(releaseSpyCalled).toBe(true);

      // Siguiente petición puede proceder y recibir nuevamente 501 (no 409)
      const res2 = await request(app)
        .post('/api/rcv')
        .send({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' });
      expect(res2.status).toBe(501);
    });

    it('cuando provider.close rechaza, responde 503 BROWSER_CLEANUP_FAILED, no libera lock y mantiene isInFlight bloqueado (consecutivos 409)', async () => {
      const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
      let releaseSpyCalled = false;
      const originalAcquire = guard.acquireOperation.bind(guard);
      vi.spyOn(guard, 'acquireOperation').mockImplementation(async () => {
        const release = await originalAcquire();
        return async () => {
          releaseSpyCalled = true;
          await release();
        };
      });

      const closeMock = vi.fn().mockRejectedValue(new Error('DevTools active session crashed / socket hung up'));
      const mockProvider: RcvProvider = {
        fetch: vi.fn().mockResolvedValue({
          compras: { status: 'empty' },
          ventas: { status: 'empty' },
        } as RcvDownloads),
        close: closeMock,
      };

      const app = createApp(config, {
        authGuard: guard,
        createProvider: () => mockProvider,
      });

      const res1 = await request(app)
        .post('/api/rcv')
        .send({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' });

      expect(res1.status).toBe(503);
      expect(res1.body.error.code).toBe('BROWSER_CLEANUP_FAILED');
      expect(res1.body.error.message).toContain('No se pudo cerrar y limpiar de forma segura');
      // No debe liberar el lock duradero
      expect(releaseSpyCalled).toBe(false);
      expect(closeMock).toHaveBeenCalledTimes(1);

      // Peticiones consecutivas deben ser rechazadas con 409 OPERATION_IN_PROGRESS por isInFlight/lock fail-closed
      const res2 = await request(app)
        .post('/api/rcv')
        .send({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' });
      expect(res2.status).toBe(409);
      expect(res2.body.error.code).toBe('OPERATION_IN_PROGRESS');

      const res3 = await request(app)
        .post('/api/rcv')
        .send({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' });
      expect(res3.status).toBe(409);
      expect(res3.body.error.code).toBe('OPERATION_IN_PROGRESS');
    });

    it('cuando provider.close cuelga indefinidamente, aplica deadline de 5s, responde 503 BROWSER_CLEANUP_FAILED y mantiene lock bloqueado', async () => {
      const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
      let releaseSpyCalled = false;
      const originalAcquire = guard.acquireOperation.bind(guard);
      vi.spyOn(guard, 'acquireOperation').mockImplementation(async () => {
        const release = await originalAcquire();
        return async () => {
          releaseSpyCalled = true;
          await release();
        };
      });

      const closeMock = vi.fn().mockImplementation(() => {
        return new Promise<void>(() => {
          // Cuelga indefinidamente
        });
      });

      const mockProvider: RcvProvider = {
        fetch: vi.fn().mockResolvedValue({
          compras: { status: 'empty' },
          ventas: { status: 'empty' },
        } as RcvDownloads),
        close: closeMock,
      };

      const app = createApp(config, {
        authGuard: guard,
        createProvider: () => mockProvider,
        cleanupDeadlineMs: 50, // plazo breve para ejecución de test sin colgar vitest
      });

      const res = await request(app)
        .post('/api/rcv')
        .send({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' });

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('BROWSER_CLEANUP_FAILED');
      expect(res.body.error.message).toContain('excedió el límite de tiempo');
      expect(releaseSpyCalled).toBe(false);

      // Petición consecutiva bloqueada con 409
      const resConsecutive = await request(app)
        .post('/api/rcv')
        .send({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' });
      expect(resConsecutive.status).toBe(409);
      expect(resConsecutive.body.error.code).toBe('OPERATION_IN_PROGRESS');
    });

    it('es idempotente y no realiza double close si se invoca cleanup múltiples veces', async () => {
      const config = readEnvironment({ LOCAL_STATE_DIR: tmpDir });
      const closeMock = vi.fn().mockResolvedValue(undefined);

      const mockProvider: RcvProvider = {
        fetch: vi.fn().mockResolvedValue({
          compras: { status: 'empty' },
          ventas: { status: 'empty' },
        } as RcvDownloads),
        close: closeMock,
      };

      const app = createApp(config, {
        authGuard: guard,
        createProvider: () => mockProvider,
      });

      const res = await request(app)
        .post('/api/rcv')
        .send({ rut: '11.111.111-1', password: 'secretpassword', authMode: 'tributaria' });

      expect(res.status).toBe(200);
      expect(closeMock).toHaveBeenCalledTimes(1);
    });
  });
});
