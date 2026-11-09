import express, { Express, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { RCV_PERIOD, credentialsSchema } from '../../../shared/rcv.js';
import { AppError, publicError } from '../domain/errors.js';
import { RcvProvider } from '../domain/rcvProvider.js';
import { AppConfig } from '../infrastructure/config/environment.js';
import { AuthAttemptGuard } from '../infrastructure/sii/authAttemptGuard.js';
import { executeGetRcv } from '../application/getRcv.js';

export interface AppDependencies {
  createProvider?: (guard: AuthAttemptGuard) => RcvProvider;
  authGuard?: AuthAttemptGuard;
  cleanupDeadlineMs?: number;
}

/**
 * Valida que una cabecera Host pertenezca estrictamente al loopback local.
 * Rechaza hosts externos, comodines y ataques con sufijos (ej. evil.localhost).
 */
function isValidLoopbackHost(hostHeader: string | undefined, _currentPort: number): boolean {
  if (!hostHeader) {
    return false;
  }
  const cleanHost = hostHeader.trim();
  // Formatos permitidos:
  // 127.0.0.1, 127.0.0.1:<port>, localhost, localhost:<port>
  // En supertest o entornos de pruebas, el puerto efímero puede estar en el Host, o bien config.port
  const hostRegex = /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/;
  return hostRegex.test(cleanHost);
}

/**
 * Valida que el Origin (si está presente) sea estrictamente el frontend local de Vite (5173) o la propia API
 */
function isValidOrigin(originHeader: string | undefined, currentPort: number): boolean {
  if (!originHeader) {
    return true; // Peticiones sin Origin son analizadas por Sec-Fetch-Site
  }
  const cleanOrigin = originHeader.trim();
  const allowedOrigins = [
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    `http://127.0.0.1:${currentPort}`,
    `http://localhost:${currentPort}`,
  ];
  return allowedOrigins.includes(cleanOrigin);
}

async function runProviderQuery(
  provider: RcvProvider,
  credentials: Parameters<typeof executeGetRcv>[1],
  abortController: AbortController,
  config: AppConfig
) {
  let timeoutTimer: NodeJS.Timeout | undefined;
  const timeoutMs = config.operationTimeoutMs;
  let timedOut = false;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      abortController.abort(new DOMException('Tiempo de operación agotado (timeout).', 'TimeoutError'));
      reject(
        new AppError(
          'GATEWAY_TIMEOUT',
          `La consulta superó el tiempo máximo de ejecución permitido (${Math.round(timeoutMs / 1000)}s).`,
          504
        )
      );
    }, timeoutMs);
  });

  const abortPromise = new Promise<never>((_, reject) => {
    if (abortController.signal.aborted) {
      reject(abortController.signal.reason);
      return;
    }
    abortController.signal.addEventListener(
      'abort',
      () => {
        if (!timedOut) {
          reject(abortController.signal.reason);
        }
      },
      { once: true }
    );
  });

  try {
    return await Promise.race([
      executeGetRcv(provider, credentials, abortController.signal, {
        limits: {
          maxCsvBytes: config.maxCsvBytes,
          maxCsvRows: config.maxCsvRows,
        },
      }),
      timeoutPromise,
      abortPromise,
    ]);
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
  }
}

function extractValidCredentials(body: unknown) {
  const parseResult = credentialsSchema.safeParse(body);
  if (!parseResult.success) {
    const issue = parseResult.error.issues[0];
    throw new AppError('INVALID_CREDENTIALS', issue?.message || 'Datos de credenciales inválidos.', 400);
  }

  if (body && typeof body === 'object') {
    try {
      (body as Record<string, unknown>).password = undefined;
    } catch {
      // En caso de body inmutable
    }
  }

  return parseResult.data;
}

async function acquireAndVerifyGuard(authGuard: AuthAttemptGuard) {
  const releaseOperation = await authGuard.acquireOperation();
  try {
    authGuard.assertAllowed();
    return releaseOperation;
  } catch (err) {
    try {
      await releaseOperation();
    } catch {
      // Ignorar fallo de release
    }
    throw err;
  }
}

async function cleanupResources(
  provider: RcvProvider | undefined,
  releaseOperation: (() => Promise<void>) | undefined,
  deadlineMs = 5000
): Promise<void> {
  let closeErr: unknown;
  if (provider) {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new AppError(
            'BROWSER_CLEANUP_FAILED',
            `El cierre del navegador excedió el límite de tiempo (${Math.round(deadlineMs / 1000)}s).`,
            503
          )
        );
      }, deadlineMs);
    });

    try {
      await Promise.race([provider.close(), timeoutPromise]);
    } catch (err: unknown) {
      closeErr = err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  if (closeErr) {
    if (closeErr instanceof AppError && closeErr.code === 'BROWSER_CLEANUP_FAILED') {
      throw closeErr;
    }
    throw new AppError(
      'BROWSER_CLEANUP_FAILED',
      'No se pudo cerrar y limpiar de forma segura la instancia del navegador.',
      503
    );
  }

  if (releaseOperation) {
    try {
      await releaseOperation();
    } catch {
      // Ignorar fallo de release
    }
  }
}

export function createApp(config: AppConfig, dependencies?: AppDependencies): Express {
  const app = express();

  const authGuard = dependencies?.authGuard ?? new AuthAttemptGuard(config.localStateDir);
  const cleanupDeadlineMs = dependencies?.cleanupDeadlineMs ?? 5000;

  let isInFlight = false;

  app.use(helmet());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    const host = req.headers['host'];
    if (!isValidLoopbackHost(host, config.port)) {
      return next(new AppError('INVALID_HOST', 'Host de solicitud no permitido.', 403));
    }

    const origin = req.headers['origin'];
    if (origin && !isValidOrigin(origin, config.port)) {
      return next(new AppError('INVALID_ORIGIN', 'Origen de solicitud no permitido.', 403));
    }

    const secFetchSite = req.headers['sec-fetch-site'];
    if (secFetchSite === 'cross-site') {
      return next(new AppError('INVALID_ORIGIN', 'Petición rechazada por política de navegación cruzada.', 403));
    }

    next();
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      status: 'ok',
      period: RCV_PERIOD,
      timestamp: new Date().toISOString(),
    });
  });

  const jsonParser = express.json({ limit: '10kb' });

  app.post('/api/rcv', (req: Request, res: Response, next: NextFunction): void => {
    if (!req.is('application/json')) {
      next(new AppError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type debe ser application/json.', 415));
      return;
    }
    jsonParser(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      handlePostRcv(req, res, next).catch(next);
    });
  });

  async function handlePostRcv(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (isInFlight) {
      next(
        new AppError(
          'OPERATION_IN_PROGRESS',
          'Ya existe una consulta de RCV en ejecución. Por favor espere a que termine.',
          409
        )
      );
      return;
    }

    let credentials;
    try {
      credentials = extractValidCredentials(req.body);
    } catch (err) {
      next(err);
      return;
    }

    let releaseOperation: (() => Promise<void>) | undefined;
    isInFlight = true;

    try {
      releaseOperation = await acquireAndVerifyGuard(authGuard);
    } catch (err: unknown) {
      isInFlight = false;
      next(err);
      return;
    }

    let provider: RcvProvider | undefined;
    const abortController = new AbortController();

    let cleanupPromise: Promise<void> | undefined;
    const performCleanup = (): Promise<void> => {
      if (!cleanupPromise) {
        cleanupPromise = cleanupResources(provider, releaseOperation, cleanupDeadlineMs);
        // Evitar unhandledRejection si nadie espera inmediatamente o si se abortó la conexión
        cleanupPromise.catch(() => {});
      }
      return cleanupPromise;
    };

    const onResponseClose = () => {
      abortController.abort(new DOMException('El cliente canceló o desconectó la solicitud.', 'AbortError'));
      void performCleanup();
    };
    res.on('close', onResponseClose);

    try {
      if (!dependencies?.createProvider) {
        throw new AppError(
          'NOT_IMPLEMENTED',
          'El proveedor de RCV (Stagehand) no está configurado en este entorno.',
          501
        );
      }

      provider = dependencies.createProvider(authGuard);

      const result = await runProviderQuery(provider, credentials, abortController, config);

      try {
        await performCleanup();
        isInFlight = false;
      } catch (cleanupErr: unknown) {
        if (res.headersSent || res.writableEnded || res.destroyed) {
          return;
        }
        next(cleanupErr);
        return;
      }

      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    } catch (err: unknown) {
      let finalErr = err;
      try {
        await performCleanup();
        isInFlight = false;
      } catch (cleanupErr: unknown) {
        // En caso de fallo de cleanup, la operación permanece bloqueada (isInFlight = true y sin releaseOperation)
        finalErr = cleanupErr;
      }

      if (res.headersSent || res.writableEnded || res.destroyed) {
        return;
      }

      next(finalErr);
    } finally {
      res.off('close', onResponseClose);
    }
  }

  // Middleware de manejo de errores centralizado (AppError envelope)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    // Si fue error de tamaño de cuerpo (payload too large 413)
    if (
      err &&
      typeof err === 'object' &&
      'type' in err &&
      (err as { type: string }).type === 'entity.too.large'
    ) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(413).json({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'El tamaño de la solicitud excede el límite permitido.',
        },
      });
      return;
    }

    // Si fue error de sintaxis JSON en el body
    if (err instanceof SyntaxError && 'status' in err && (err as { status: number }).status === 400) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(400).json({
        error: {
          code: 'MALFORMED_JSON',
          message: 'El cuerpo de la solicitud no es un JSON válido.',
        },
      });
      return;
    }

    const pub = publicError(err);
    const status = err instanceof AppError ? err.httpStatus : 500;

    res.setHeader('Cache-Control', 'no-store');
    if (pub.retryAfterSeconds && status === 429) {
      res.setHeader('Retry-After', String(pub.retryAfterSeconds));
    }

    res.status(status).json({
      error: pub,
    });
  });

  return app;
}
