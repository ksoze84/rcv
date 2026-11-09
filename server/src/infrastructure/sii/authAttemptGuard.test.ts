import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AuthAttemptGuard } from './authAttemptGuard.js';
import { AppError } from '../../domain/errors.js';

describe('AuthAttemptGuard', () => {
  let tmpDir: string;
  let simulatedTime: number;
  const fakeClock = () => simulatedTime;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-guard-test-'));
    simulatedTime = 1_000_000;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('permite primer intento y persiste nextAllowedAt a los 15s', async () => {
    const guard = new AuthAttemptGuard(tmpDir, fakeClock);
    await expect(guard.reserveAttempt(15)).resolves.toBeUndefined();

    const state = guard.getState();
    expect(state.nextAllowedAt).toBe(simulatedTime + 15_000);
    expect(state.blockedUntil).toBe(0);
  });

  it('rechaza con 429 RATE_LIMITED si se intenta antes de que pasen los 15s', async () => {
    const guard = new AuthAttemptGuard(tmpDir, fakeClock);
    await guard.reserveAttempt(15);

    // Avanzamos 5 segundos (quedan 10s)
    simulatedTime += 5000;

    let error: unknown;
    try {
      await guard.reserveAttempt(15);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(AppError);
    const appErr = error as AppError;
    expect(appErr.httpStatus).toBe(429);
    expect(appErr.code).toBe('RATE_LIMITED');
    expect(appErr.retryAfterSeconds).toBe(10);
  });

  it('permite nuevo intento una vez transcurridos los 15s', async () => {
    const guard = new AuthAttemptGuard(tmpDir, fakeClock);
    await guard.reserveAttempt(15);

    simulatedTime += 15_000;
    await expect(guard.reserveAttempt(15)).resolves.toBeUndefined();
    expect(guard.getState().nextAllowedAt).toBe(simulatedTime + 15_000);
  });

  it('markBlocked impone bloqueo preventivo >= 30m (1800s) y sobrevive recargas', async () => {
    const guard1 = new AuthAttemptGuard(tmpDir, fakeClock);
    guard1.markBlocked(3600);

    // Instancia nueva compartiendo el directorio en disco (simula reinicio de servidor)
    const guard2 = new AuthAttemptGuard(tmpDir, fakeClock);

    let error: unknown;
    try {
      await guard2.reserveAttempt(15);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(AppError);
    const appErr = error as AppError;
    expect(appErr.httpStatus).toBe(429);
    expect(appErr.code).toBe('ACCOUNT_BLOCKED');
    expect(appErr.retryAfterSeconds).toBe(3600);

    // Monotónico: no reduce el bloqueo si se intenta marcar con un tiempo menor (>= 1800)
    simulatedTime += 100_000;
    guard2.markBlocked(1800); // 100_000 + 1800*1000 = 1_900_000 < 3_600_000 + 1_000_000
    expect(guard2.getState().blockedUntil).toBe(1_000_000 + 3600 * 1000);

    // Rechaza duraciones < 1800 o inválidas
    expect(() => guard2.markBlocked(60)).toThrow(
      expect.objectContaining({ code: 'INVALID_BLOCK_DURATION', httpStatus: 400 })
    );
    expect(() => guard2.markBlocked(NaN)).toThrow(
      expect.objectContaining({ code: 'INVALID_BLOCK_DURATION', httpStatus: 400 })
    );
    expect(() => guard2.markBlocked(-10)).toThrow(
      expect.objectContaining({ code: 'INVALID_BLOCK_DURATION', httpStatus: 400 })
    );
  });

  it('assertAllowed no muta estado y valida clock en 0, 14.999 y 15s', async () => {
    simulatedTime = 0;
    const guard = new AuthAttemptGuard(tmpDir, fakeClock);

    // Sin reservas iniciales, assertAllowed pasa y no muta
    expect(() => guard.assertAllowed()).not.toThrow();
    expect(guard.getState()).toEqual({ nextAllowedAt: 0, blockedUntil: 0 });

    // Reservamos a t = 0
    await guard.reserveAttempt(15);
    expect(guard.getState().nextAllowedAt).toBe(15_000);

    // Exactamente en t = 0: assertAllowed falla con 15s y no muta
    try {
      guard.assertAllowed();
      expect.unreachable('Debe lanzar RATE_LIMITED');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const appErr = e as AppError;
      expect(appErr.code).toBe('RATE_LIMITED');
      expect(appErr.retryAfterSeconds).toBe(15);
    }
    expect(guard.getState().nextAllowedAt).toBe(15_000);

    // A t = 14.999s: assertAllowed falla con 1s restante
    simulatedTime = 14_999;
    try {
      guard.assertAllowed();
      expect.unreachable('Debe lanzar RATE_LIMITED');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const appErr = e as AppError;
      expect(appErr.code).toBe('RATE_LIMITED');
      expect(appErr.retryAfterSeconds).toBe(1);
    }

    // A t = 15.000s: assertAllowed pasa
    simulatedTime = 15_000;
    expect(() => guard.assertAllowed()).not.toThrow();
  });

  it('reserveAttempt valida intervalos >= 15 y rechaza NaN o negativos', async () => {
    const guard = new AuthAttemptGuard(tmpDir, fakeClock);

    await expect(guard.reserveAttempt(14)).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_INTERVAL', httpStatus: 400 })
    );
    await expect(guard.reserveAttempt(0)).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_INTERVAL', httpStatus: 400 })
    );
    await expect(guard.reserveAttempt(-5)).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_INTERVAL', httpStatus: 400 })
    );
    await expect(guard.reserveAttempt(NaN)).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_INTERVAL', httpStatus: 400 })
    );
  });

  it('falla cerrado (503 GUARD_STATE_INVALID) ante JSON corrupto o valores invalidos en vez de resetear a 0', () => {
    const guard = new AuthAttemptGuard(tmpDir, fakeClock);
    const stateFile = path.join(tmpDir, 'auth-guard-state.json');

    // 1. JSON con sintaxis corrupta
    fs.writeFileSync(stateFile, '{"nextAllowedAt": corrupted');
    expect(() => guard.getState()).toThrow(
      expect.objectContaining({ code: 'GUARD_STATE_INVALID', httpStatus: 503 })
    );
    expect(() => guard.assertAllowed()).toThrow(
      expect.objectContaining({ code: 'GUARD_STATE_INVALID', httpStatus: 503 })
    );

    // 2. Valores inválidos (negativos o NaN en JSON)
    fs.writeFileSync(stateFile, JSON.stringify({ nextAllowedAt: -100, blockedUntil: 0 }));
    expect(() => guard.getState()).toThrow(
      expect.objectContaining({ code: 'GUARD_STATE_INVALID', httpStatus: 503 })
    );

    // 3. Tipos inválidos (strings o arrays)
    fs.writeFileSync(stateFile, JSON.stringify({ nextAllowedAt: 'invalido', blockedUntil: 0 }));
    expect(() => guard.getState()).toThrow(
      expect.objectContaining({ code: 'GUARD_STATE_INVALID', httpStatus: 503 })
    );

    fs.writeFileSync(stateFile, JSON.stringify([1, 2, 3]));
    expect(() => guard.getState()).toThrow(
      expect.objectContaining({ code: 'GUARD_STATE_INVALID', httpStatus: 503 })
    );
  });

  it('no borra lockdir sin dueño por edad (fail closed sin stale recovery ciego)', async () => {
    const guard = new AuthAttemptGuard(tmpDir, fakeClock);
    const lockDir = path.join(tmpDir, 'operation.lock');
    fs.mkdirSync(lockDir, { mode: 0o700 });

    // Avanzar tiempo significativamente
    simulatedTime += 1_000_000;

    // Sin owner.json, no se debe borrar automáticamente por edad
    await expect(guard.acquireOperation()).rejects.toThrow(
      expect.objectContaining({ code: 'OPERATION_IN_PROGRESS', httpStatus: 409 })
    );
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  it('adquiere exclusividad cross-process y rechaza segunda operación simultánea con 409', async () => {
    const guard1 = new AuthAttemptGuard(tmpDir, fakeClock);
    const guard2 = new AuthAttemptGuard(tmpDir, fakeClock);

    const release1 = await guard1.acquireOperation();

    // Intentar adquirir desde la otra instancia mientras la primera está activa
    await expect(guard2.acquireOperation()).rejects.toThrow(
      expect.objectContaining({
        httpStatus: 409,
        code: 'OPERATION_IN_PROGRESS',
      })
    );

    // Liberar la primera
    await release1();

    // Ahora la segunda puede adquirir con éxito
    const release2 = await guard2.acquireOperation();
    await release2();
  });

  it('no almacena contraseñas ni RUTs en disco ni en el estado JSON', async () => {
    const guard = new AuthAttemptGuard(tmpDir, fakeClock);
    await guard.reserveAttempt(15);
    guard.markBlocked(1800);

    const files = fs.readdirSync(tmpDir);
    for (const f of files) {
      const content = fs.readFileSync(path.join(tmpDir, f), 'utf8');
      expect(content).not.toMatch(/password|contrase|rut/i);
    }
  });
});
