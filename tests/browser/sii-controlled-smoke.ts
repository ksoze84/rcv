import { loadSafeEnvFile, readEnvironment, readSmokeCredentials, SmokeCredentials } from '../../server/src/infrastructure/config/environment.js';
import { AuthAttemptGuard } from '../../server/src/infrastructure/sii/authAttemptGuard.js';
import { BrowserSession } from '../../server/src/infrastructure/sii/browserSession.js';
import { assertTributariaFormSecurity, authenticateTributaria } from '../../server/src/infrastructure/sii/tributariaAuth.js';
import {
  assertClaveUnicaFormSecurity,
  authenticateClaveUnica,
  ClaveUnicaReturnDiagnostic,
} from '../../server/src/infrastructure/sii/claveUnicaAuth.js';
import { verifyActiveContributorIdentity, isExactRcvPortalUrl } from '../../server/src/infrastructure/sii/rcvNavigation.js';
import { extractSafeOriginAndPath, parseExactOrigin, boundedHumanDelay } from '../../server/src/infrastructure/sii/siiPage.js';
import { executeGetRcv, RcvAggregateDiagnostic } from '../../server/src/application/getRcv.js';
import { StagehandRcvProvider } from '../../server/src/infrastructure/sii/stagehandRcvProvider.js';
import { AuthMode, RcvTabDiagnostic } from '../../shared/rcv.js';
import { AppError } from '../../server/src/domain/errors.js';

export interface ControlledSmokeResult {
  mode: AuthMode;
  status: 'SUCCESS' | 'FAILED' | 'NOT_RUN';
  phase?: 'init' | 'formulario' | 'retorno' | 'identidad' | 'completed';
  code?: string;
  period?: string;
  rcvStatus?: 'complete' | 'partial';
  compras?: {
    status: 'ok' | 'empty' | 'error';
    count: number | null;
    error?: string;
    stage?: string;
    tabDiagnostic?: RcvTabDiagnostic;
  };
  ventas?: {
    status: 'ok' | 'empty' | 'error';
    count: number | null;
    error?: string;
    stage?: string;
    tabDiagnostic?: RcvTabDiagnostic;
  };
  formularioOk?: boolean;
  formOrigin?: string | null;
  retornoOk?: boolean;
  postReturnOrigin?: string | null;
  identidadOk?: boolean;
  retornoDiagnostico?: ClaveUnicaReturnDiagnostic;
  authenticationWasReserved: boolean;
  blocked: boolean;
  elapsedMs: number;
}

export interface BuildSmokeFailedResultParams {
  isFull: boolean;
  mode: AuthMode;
  currentPhase?: 'init' | 'formulario' | 'retorno' | 'identidad' | 'completed';
  safeCode: string;
  error?: unknown;
  aggregateDiagnostic?: RcvAggregateDiagnostic;
  formularioOk?: boolean;
  formOrigin?: string | null;
  retornoOk?: boolean;
  postReturnOrigin?: string | null;
  identidadOk?: boolean;
  retornoDiagnostico?: ClaveUnicaReturnDiagnostic;
  authenticationWasReserved: boolean;
  blocked: boolean;
  elapsedMs: number;
}

export function buildSmokeFailedResult(params: BuildSmokeFailedResultParams): ControlledSmokeResult {
  if (params.isFull) {
    let comprasField: ControlledSmokeResult['compras'];
    let ventasField: ControlledSmokeResult['ventas'];

    if (params.aggregateDiagnostic) {
      comprasField = params.aggregateDiagnostic.compras;
      ventasField = params.aggregateDiagnostic.ventas;
    } else if (params.error instanceof AppError && params.error.details) {
      const details = params.error.details as {
        comprasCode?: string;
        ventasCode?: string;
        comprasStage?: string;
        ventasStage?: string;
        comprasTabDiagnostic?: RcvTabDiagnostic;
        ventasTabDiagnostic?: RcvTabDiagnostic;
      };
      if (details.comprasCode) {
        comprasField = {
          status: 'error',
          count: null,
          error: details.comprasCode,
          ...(details.comprasStage ? { stage: details.comprasStage } : {}),
          ...(details.comprasTabDiagnostic ? { tabDiagnostic: details.comprasTabDiagnostic } : {}),
        };
      }
      if (details.ventasCode) {
        ventasField = {
          status: 'error',
          count: null,
          error: details.ventasCode,
          ...(details.ventasStage ? { stage: details.ventasStage } : {}),
          ...(details.ventasTabDiagnostic ? { tabDiagnostic: details.ventasTabDiagnostic } : {}),
        };
      }
    }

    return {
      mode: params.mode,
      status: 'FAILED',
      phase: params.currentPhase,
      code: params.safeCode,
      period: '2026-02',
      ...(comprasField ? { compras: comprasField } : {}),
      ...(ventasField ? { ventas: ventasField } : {}),
      ...(params.retornoDiagnostico ? { retornoDiagnostico: params.retornoDiagnostico } : {}),
      authenticationWasReserved: params.authenticationWasReserved,
      blocked: params.blocked,
      elapsedMs: params.elapsedMs,
    };
  }

  return {
    mode: params.mode,
    status: 'FAILED',
    phase: params.currentPhase,
    code: params.safeCode,
    formularioOk: params.formularioOk ?? false,
    formOrigin: params.formOrigin ?? null,
    retornoOk: params.retornoOk ?? false,
    postReturnOrigin: params.postReturnOrigin ?? null,
    identidadOk: params.identidadOk ?? false,
    ...(params.retornoDiagnostico ? { retornoDiagnostico: params.retornoDiagnostico } : {}),
    authenticationWasReserved: params.authenticationWasReserved,
    blocked: params.blocked,
    elapsedMs: params.elapsedMs,
  };
}

const RCV_PORTAL_URL = 'https://www4.sii.cl/consdcvinternetui/#/index';

async function performAuthFlow(
  session: BrowserSession,
  mode: AuthMode,
  credentials: SmokeCredentials,
  guard: AuthAttemptGuard,
  signal: AbortSignal,
  onCuReturnDiag?: (diag: ClaveUnicaReturnDiagnostic) => void
): Promise<{ formOrigin: string | null; diagnosticoRetorno?: ClaveUnicaReturnDiagnostic }> {
  if (mode === 'tributaria') {
    if (session.page.waitForSelector) {
      await session.page.waitForSelector('#rutcntr', { timeout: 15000 }).catch(() => {});
    }
    await assertTributariaFormSecurity(session.page);
    const formOrigin = parseExactOrigin(await session.page.url())?.origin ?? null;

    await authenticateTributaria({
      page: session.page,
      rut: credentials.user,
      password: credentials.pass,
      guard,
      signal,
    });
    return { formOrigin };
  }

  if (session.page.waitForSelector) {
    await session.page.waitForSelector('#myHref, #login-form', { timeout: 15000 }).catch(() => {});
  }
  const cuCurrentUrl = await session.page.url();
  const parsedCuOrigin = parseExactOrigin(cuCurrentUrl);
  if (parsedCuOrigin?.origin === 'https://accounts.claveunica.gob.cl') {
    await assertClaveUnicaFormSecurity(session.page);
  }

  const authResult = await authenticateClaveUnica({
    page: session.page,
    rut: credentials.user,
    password: credentials.pass,
    guard,
    signal,
    onReturnDiagnostic: onCuReturnDiag,
  });
  return {
    formOrigin: authResult.formOrigin,
    diagnosticoRetorno: authResult.diagnosticoRetorno,
  };
}

async function waitForRcvLanding(
  session: BrowserSession,
  signal: AbortSignal
): Promise<{ origin: string | null; isPortal: boolean }> {
  const postLoginUrl = await session.page.url();
  if (!isExactRcvPortalUrl(postLoginUrl)) {
    await session.page.goto(RCV_PORTAL_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await boundedHumanDelay(500, 1000, signal);
  } else {
    if (session.page.waitForSelector) {
      await session.page.waitForSelector(
        '#consdcv, #rcvApp, #app, [ng-app], select, #myRut, .user-info',
        { timeout: 15000 }
      ).catch(() => {});
    }
    await boundedHumanDelay(300, 600, signal);
  }

  const verifiedPostUrl = await session.page.url();
  const origin = parseExactOrigin(verifiedPostUrl)?.origin ?? null;
  const isPortal = isExactRcvPortalUrl(verifiedPostUrl);
  return { origin, isPortal };
}

export async function runControlledSmoke(): Promise<void> {
  const rawMode = process.argv[2];
  const isPreSubmitOnly = process.argv.includes('--pre-submit');
  const isFull = process.argv.includes('--full');
  if (!rawMode || (rawMode !== 'tributaria' && rawMode !== 'clave-unica')) {
    console.error('Uso: node --import tsx tests/browser/sii-controlled-smoke.ts <tributaria|clave-unica> [--pre-submit|--full]');
    process.exit(1);
  }

  const mode = rawMode as AuthMode;
  const started = Date.now();

  loadSafeEnvFile();
  const config = readEnvironment();
  const guard = new AuthAttemptGuard(config.localStateDir);
  const initialNextAllowed = guard.getState().nextAllowedAt;

  let release: (() => Promise<void>) | undefined;
  let session: BrowserSession | undefined;
  let provider: StagehandRcvProvider | undefined;

  let currentPhase: 'init' | 'formulario' | 'retorno' | 'identidad' | 'completed' = 'init';
  let formularioOk = false;
  let formOrigin: string | null = null;
  let retornoOk = false;
  let postReturnOrigin: string | null = null;
  let identidadOk = false;
  let retornoDiagnostico: ClaveUnicaReturnDiagnostic | undefined;
  let aggregateDiagnostic: RcvAggregateDiagnostic | undefined;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new AppError('TIMEOUT', 'Tiempo de operación agotado en prueba controlada.', 504));
  }, Math.min(config.operationTimeoutMs, isFull ? 120000 : 60000));

  try {
    let credentials: SmokeCredentials | null = null;
    if (!isPreSubmitOnly) {
      guard.assertAllowed();
      credentials = readSmokeCredentials(process.env, mode);
      if (!credentials) {
        throw new AppError('MISSING_CREDENTIALS', 'Credenciales no configuradas para modo de prueba.', 400);
      }
      release = await guard.acquireOperation();
    }

    if (isPreSubmitOnly) {
      session = await BrowserSession.start({
        ...(config.chromePath ? { chromePath: config.chromePath } : {}),
        headless: config.headless,
      });

      currentPhase = 'formulario';
      await session.page.goto(RCV_PORTAL_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      const initialUrl = await session.page.url();
      if (initialUrl.startsWith('chrome-error://')) {
        throw new AppError('NAVIGATION_ERROR', 'Error de red o resolución DNS en portal SII.', 502);
      }

      await boundedHumanDelay(300, 500, controller.signal);

      if (mode === 'tributaria') {
        if (session.page.waitForSelector) {
          await session.page.waitForSelector('#rutcntr', { timeout: 15000 }).catch(() => {});
        }
        await assertTributariaFormSecurity(session.page);
        formOrigin = parseExactOrigin(await session.page.url())?.origin ?? null;
        formularioOk = true;
      } else {
        if (session.page.waitForSelector) {
          await session.page.waitForSelector('#myHref', { timeout: 15000 }).catch(() => {});
        }
        const link = session.page.locator('#myHref');
        await link.click();

        const waitLimit = Date.now() + 15000;
        while (Date.now() < waitLimit) {
          const cur = await session.page.url();
          const p = parseExactOrigin(cur);
          if (p?.origin === 'https://accounts.claveunica.gob.cl') {
            break;
          }
          await boundedHumanDelay(200, 300, controller.signal);
        }
        await assertClaveUnicaFormSecurity(session.page, controller.signal);
        formOrigin = 'https://accounts.claveunica.gob.cl';
        formularioOk = true;
      }

      const preSubmitResult: ControlledSmokeResult = {
        mode,
        status: 'SUCCESS',
        phase: 'formulario',
        formularioOk: true,
        formOrigin,
        retornoOk: false,
        postReturnOrigin: null,
        identidadOk: false,
        authenticationWasReserved: false,
        blocked: false,
        elapsedMs: Date.now() - started,
      };
      console.log(JSON.stringify(preSubmitResult));
    } else if (isFull) {
      // Flujo COMPLETO usando executeGetRcv y proveedor real
      provider = new StagehandRcvProvider(config, guard);

      const rcvResult = await executeGetRcv(
        provider,
        {
          authMode: mode,
          rut: credentials!.user,
          password: credentials!.pass,
        },
        controller.signal,
        {
          onDiagnostic: (diag) => {
            aggregateDiagnostic = diag;
          },
        }
      );

      const comprasCount =
        rcvResult.compras.status === 'ok'
          ? rcvResult.compras.rows.length
          : rcvResult.compras.status === 'empty'
          ? 0
          : null;

      const ventasCount =
        rcvResult.ventas.status === 'ok'
          ? rcvResult.ventas.rows.length
          : rcvResult.ventas.status === 'empty'
          ? 0
          : null;

      currentPhase = 'completed';
      const fullResult: ControlledSmokeResult = {
        mode,
        status: 'SUCCESS',
        phase: currentPhase,
        period: `${rcvResult.period.year}-${rcvResult.period.month < 10 ? '0' : ''}${rcvResult.period.month}`,
        rcvStatus: rcvResult.status,
        compras: {
          status: rcvResult.compras.status,
          count: comprasCount,
          ...(rcvResult.compras.status === 'error'
            ? {
                error: rcvResult.compras.error.code,
                ...(rcvResult.compras.error.stage ? { stage: rcvResult.compras.error.stage } : {}),
                ...(rcvResult.compras.error.tabDiagnostic ? { tabDiagnostic: rcvResult.compras.error.tabDiagnostic } : {}),
              }
            : {}),
        },
        ventas: {
          status: rcvResult.ventas.status,
          count: ventasCount,
          ...(rcvResult.ventas.status === 'error'
            ? {
                error: rcvResult.ventas.error.code,
                ...(rcvResult.ventas.error.stage ? { stage: rcvResult.ventas.error.stage } : {}),
                ...(rcvResult.ventas.error.tabDiagnostic ? { tabDiagnostic: rcvResult.ventas.error.tabDiagnostic } : {}),
              }
            : {}),
        },
        authenticationWasReserved: guard.getState().nextAllowedAt > initialNextAllowed,
        blocked: guard.getState().blockedUntil > Date.now(),
        elapsedMs: Date.now() - started,
      };
      console.log(JSON.stringify(fullResult));
    } else {
      session = await BrowserSession.start({
        ...(config.chromePath ? { chromePath: config.chromePath } : {}),
        headless: config.headless,
      });

      currentPhase = 'formulario';
      await session.page.goto(RCV_PORTAL_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      const initialUrl = await session.page.url();
      if (initialUrl.startsWith('chrome-error://')) {
        throw new AppError('NAVIGATION_ERROR', 'Error de red o resolución DNS en portal SII.', 502);
      }

      await boundedHumanDelay(300, 500, controller.signal);

      const isLoginRequired =
        initialUrl.includes('IngresoRutClave.html') ||
        initialUrl.includes('zeusr.sii.cl') ||
        initialUrl.includes('accounts.claveunica.gob.cl');

      if (isLoginRequired) {
        const authFormInfo = await performAuthFlow(
          session,
          mode,
          credentials!,
          guard,
          controller.signal,
          (diag) => {
            retornoDiagnostico = diag;
          }
        );
        formOrigin = authFormInfo.formOrigin;
        if (authFormInfo.diagnosticoRetorno) {
          retornoDiagnostico = authFormInfo.diagnosticoRetorno;
        }
        formularioOk = true;
        currentPhase = 'retorno';
      } else {
        formularioOk = true;
        formOrigin = parseExactOrigin(initialUrl)?.origin ?? null;
        currentPhase = 'retorno';
      }

      const landing = await waitForRcvLanding(session, controller.signal);
      postReturnOrigin = landing.origin;
      retornoOk = landing.isPortal;

      if (!retornoOk) {
        throw new AppError('NAVIGATION_ERROR', 'No se alcanzó el portal RCV esperado tras la autenticación.', 502);
      }

      currentPhase = 'identidad';
      const identity = await verifyActiveContributorIdentity(
        session.page,
        credentials!.user,
        controller.signal,
        15000
      );

      identidadOk = identity.verified;
      if (!identidadOk) {
        throw new AppError('SESSION_UNVERIFIED', 'No se pudo verificar la identidad activa en RCV.', 401);
      }

      currentPhase = 'completed';
      const successResult: ControlledSmokeResult = {
        mode,
        status: 'SUCCESS',
        phase: currentPhase,
        formularioOk,
        formOrigin,
        retornoOk,
        postReturnOrigin,
        identidadOk,
        ...(retornoDiagnostico ? { retornoDiagnostico } : {}),
        authenticationWasReserved: guard.getState().nextAllowedAt > initialNextAllowed,
        blocked: guard.getState().blockedUntil > Date.now(),
        elapsedMs: Date.now() - started,
      };
      console.log(JSON.stringify(successResult));
    }
  } catch (error: unknown) {
    if (error instanceof AppError && error.code === 'ACCOUNT_BLOCKED') {
      guard.markBlocked(Math.max(error.retryAfterSeconds ?? 1800, 1800));
    }
    const safeCode = error instanceof AppError ? error.code : 'TECHNICAL_ERROR';

    // Si falló en clave-unica y no tenemos retornoDiagnostico aún, intentar una inspección segura
    if (mode === 'clave-unica' && !retornoDiagnostico && session) {
      try {
        const curUrl = await session.page.url();
        const safeUrl = extractSafeOriginAndPath(curUrl);
        const formRemains = await session.page.evaluate(() => {
          const form = document.querySelector('form#login-form');
          const uname = document.querySelector('#uname, input#uname');
          return Boolean(form || uname);
        }).catch(() => false);

        retornoDiagnostico = {
          formularioSigue: formRemains,
          origen: safeUrl.origin,
          ruta: safeUrl.path,
          codigo: safeCode,
        };
      } catch {
        // Ignorar fallo de inspección secundaria
      }
    }

    const failedResult = buildSmokeFailedResult({
      isFull,
      mode,
      currentPhase,
      safeCode,
      error,
      aggregateDiagnostic,
      formularioOk,
      formOrigin,
      retornoOk,
      postReturnOrigin,
      identidadOk,
      retornoDiagnostico,
      authenticationWasReserved: guard.getState().nextAllowedAt > initialNextAllowed,
      blocked: guard.getState().blockedUntil > Date.now(),
      elapsedMs: Date.now() - started,
    });
    console.log(JSON.stringify(failedResult));
    process.exitCode = 1;
  } finally {
    clearTimeout(timeoutId);
    if (provider) {
      await provider.close().catch(() => {});
    }
    if (session) {
      await session.close().catch(() => {});
    }
    if (release) {
      await release().catch(() => {});
    }
  }
}

const isExecutedDirectly =
  typeof process.argv[1] === 'string' &&
  /(?:^|[\\/])sii-controlled-smoke\.[cm]?[jt]s$/.test(process.argv[1]);

if (isExecutedDirectly) {
  runControlledSmoke().catch((err) => {
    console.error('Error fatal en ejecución de smoke:', err);
    process.exit(1);
  });
}
