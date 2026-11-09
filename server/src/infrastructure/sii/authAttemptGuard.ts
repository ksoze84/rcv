import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError } from '../../domain/errors.js';

export interface GuardState {
  nextAllowedAt: number;
  blockedUntil: number;
}

export type OperationRelease = () => Promise<void>;

/**
 * AuthAttemptGuard
 * Gestiona la sincronización entre procesos y las restricciones temporales
 * de reintento (>=15s entre envíos de credenciales) y bloqueo preventivo
 * (>=30m si la cuenta o portal fue bloqueado).
 *
 * NO guarda RUTs ni contraseñas en disco ni en memoria.
 * Persiste exclusivamente marcas de tiempo (nextAllowedAt, blockedUntil)
 * en un archivo JSON con permisos 0600 y directorio con 0700.
 * Bloqueo exclusivo de proceso/cross-process atómico mediante directorio operation.lock.
 */
export class AuthAttemptGuard {
  private readonly stateDir: string;
  private readonly stateFilePath: string;
  private readonly lockDirPath: string;
  private readonly clock: () => number;

  constructor(stateDir: string, clock: () => number = Date.now) {
    this.stateDir = path.resolve(stateDir);
    this.stateFilePath = path.join(this.stateDir, 'auth-guard-state.json');
    this.lockDirPath = path.join(this.stateDir, 'operation.lock');
    this.clock = clock;
  }

  /**
   * Garantiza la existencia del directorio con permisos restringidos 0700
   */
  private ensureDirectory(): void {
    if (!fs.existsSync(this.stateDir)) {
      fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    }
    try {
      fs.chmodSync(this.stateDir, 0o700);
    } catch {
      // Ignorar fallo de chmod en sistemas de archivos no POSIX
    }
  }

  /**
   * Lee el estado persistido. Si no existe, retorna estado inicial limpio.
   * Si el archivo está corrupto o tiene datos inválidos, lanza AppError 503.
   */
  public getState(): GuardState {
    this.ensureDirectory();

    let content: string;
    try {
      content = fs.readFileSync(this.stateFilePath, 'utf8');
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { nextAllowedAt: 0, blockedUntil: 0 };
      }
      throw new AppError(
        'GUARD_STATE_INVALID',
        'El estado de autenticación es inválido o no se puede leer.',
        503
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new AppError(
        'GUARD_STATE_INVALID',
        'El estado de autenticación es inválido o no se puede leer.',
        503
      );
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new AppError(
        'GUARD_STATE_INVALID',
        'El estado de autenticación es inválido o no se puede leer.',
        503
      );
    }

    const { nextAllowedAt, blockedUntil } = parsed as Record<string, unknown>;
    if (
      typeof nextAllowedAt !== 'number' ||
      !Number.isFinite(nextAllowedAt) ||
      nextAllowedAt < 0 ||
      typeof blockedUntil !== 'number' ||
      !Number.isFinite(blockedUntil) ||
      blockedUntil < 0
    ) {
      throw new AppError(
        'GUARD_STATE_INVALID',
        'El estado de autenticación es inválido o no se puede leer.',
        503
      );
    }

    return { nextAllowedAt, blockedUntil };
  }

  /**
   * Guarda de forma atómica el estado persistente mediante archivo temporal y rename,
   * asignando permisos 0600 y creación exclusiva 'wx'.
   */
  private saveState(state: GuardState): void {
    this.ensureDirectory();
    const tempFile = path.join(this.stateDir, `guard-state.${crypto.randomUUID()}.tmp`);
    const payload = JSON.stringify({
      nextAllowedAt: state.nextAllowedAt,
      blockedUntil: state.blockedUntil,
    });

    fs.writeFileSync(tempFile, payload, { flag: 'wx', mode: 0o600, encoding: 'utf8' });
    try {
      fs.chmodSync(tempFile, 0o600);
    } catch {
      // Ignorar fallo de chmod si el FS no lo soporta
    }

    fs.renameSync(tempFile, this.stateFilePath);
  }

  /**
   * Intenta adquirir la esclusa de operación exclusiva entre procesos
   * usando un lockdir atómico (mkdir operation.lock) sin auto-recuperación ciega.
   */
  public async acquireOperation(): Promise<OperationRelease> {
    this.ensureDirectory();

    let acquired = false;
    const lockInfoFile = path.join(this.lockDirPath, 'owner.json');

    try {
      fs.mkdirSync(this.lockDirPath, { mode: 0o700 });
      try {
        fs.writeFileSync(
          lockInfoFile,
          JSON.stringify({ pid: process.pid, createdAt: this.clock() }),
          { flag: 'wx', mode: 0o600 }
        );
        acquired = true;
      } catch (writeErr) {
        try {
          fs.rmSync(this.lockDirPath, { recursive: true, force: true });
        } catch {
          // Ignorar fallo de limpieza tras fallo de escritura
        }
        throw writeErr;
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        acquired = false;
      } else {
        throw err;
      }
    }

    if (!acquired) {
      throw new AppError(
        'OPERATION_IN_PROGRESS',
        'Ya existe una operación de consulta en curso. Espere a que finalice.',
        409
      );
    }

    let released = false;
    const release: OperationRelease = async () => {
      if (released) return;
      released = true;
      try {
        if (fs.existsSync(lockInfoFile)) {
          const raw = fs.readFileSync(lockInfoFile, 'utf8');
          const info = JSON.parse(raw) as { pid?: number };
          if (info.pid === process.pid) {
            fs.rmSync(this.lockDirPath, { recursive: true, force: true });
          }
        }
      } catch {
        // Ignorar fallo de release
      }
    };

    return release;
  }

  /**
   * Comprueba sin mutar si un intento está permitido según el estado persistido.
   * Lanza ACCOUNT_BLOCKED (429) o RATE_LIMITED (429) si no está permitido.
   */
  public assertAllowed(): void {
    const now = this.clock();
    const state = this.getState();

    if (state.blockedUntil > now) {
      const waitSeconds = Math.ceil((state.blockedUntil - now) / 1000);
      throw new AppError(
        'ACCOUNT_BLOCKED',
        `La cuenta o portal se encuentra temporalmente bloqueado. Debe esperar ${waitSeconds} segundos antes de intentar nuevamente.`,
        429,
        waitSeconds
      );
    }

    if (state.nextAllowedAt > now) {
      const waitSeconds = Math.ceil((state.nextAllowedAt - now) / 1000);
      throw new AppError(
        'RATE_LIMITED',
        `Debe esperar al menos ${waitSeconds} segundos entre cada intento de autenticación.`,
        429,
        waitSeconds
      );
    }
  }

  /**
   * Reserva un intento de autenticación verificando los tiempos de enfriamiento y bloqueo.
   * Requiere un intervalo mínimo de al menos 15 segundos.
   */
  public async reserveAttempt(minIntervalSeconds: number = 15): Promise<void> {
    if (
      typeof minIntervalSeconds !== 'number' ||
      !Number.isFinite(minIntervalSeconds) ||
      minIntervalSeconds < 15
    ) {
      throw new AppError(
        'INVALID_INTERVAL',
        'El intervalo mínimo debe ser un número finito de al menos 15 segundos.',
        400
      );
    }

    this.assertAllowed();

    const now = this.clock();
    const state = this.getState();
    const nextAllowedAt = now + minIntervalSeconds * 1000;
    this.saveState({
      ...state,
      nextAllowedAt,
    });
  }

  /**
   * Registra un bloqueo de cuenta/portal preventivo de al menos 1800s (30m).
   * Monotónico: no reduce un bloqueo mayor existente.
   */
  public markBlocked(seconds: number = 1800): void {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 1800) {
      throw new AppError(
        'INVALID_BLOCK_DURATION',
        'La duración del bloqueo debe ser un número finito de al menos 1800 segundos.',
        400
      );
    }

    const now = this.clock();
    const state = this.getState();
    const proposedBlockedUntil = now + seconds * 1000;
    const blockedUntil = Math.max(state.blockedUntil, proposedBlockedUntil);

    this.saveState({
      ...state,
      blockedUntil,
    });
  }
}
