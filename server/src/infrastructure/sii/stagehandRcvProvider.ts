import { Credentials, PublicError, RcvTabDiagnostic } from '../../../../shared/rcv.js';
import { AppError, isAppError } from '../../domain/errors.js';
import { DownloadResult, RcvDownloads, RcvProvider } from '../../domain/rcvProvider.js';
import { AppConfig } from '../config/environment.js';
import { AuthAttemptGuard } from './authAttemptGuard.js';
import { BrowserSession } from './browserSession.js';
import { authenticateTributaria } from './tributariaAuth.js';
import { authenticateClaveUnica } from './claveUnicaAuth.js';
import {
  verifyActiveContributorIdentity,
  selectAndInspectRcvTab,
  triggerRcvDownload,
  PeriodSelectionOptions,
} from './rcvNavigation.js';
import { captureDownload } from './captureDownload.js';
import { boundedHumanDelay } from './siiPage.js';

const RCV_PORTAL_URL = 'https://www4.sii.cl/consdcvinternetui/#/index';

export class StagehandRcvProvider implements RcvProvider {
  private readonly config: AppConfig;
  private readonly guard: AuthAttemptGuard;
  private sessionPromise: Promise<BrowserSession> | null = null;
  private currentSession: BrowserSession | null = null;
  private isClosed = false;

  constructor(config: AppConfig, guard: AuthAttemptGuard) {
    this.config = config;
    this.guard = guard;
  }

  /**
   * Obtiene o inicia la sesión de navegador de forma cancelable y protegida ante concurrencia.
   */
  private async getOrCreateSession(signal: AbortSignal): Promise<BrowserSession> {
    if (this.isClosed) {
      throw new AppError('PROVIDER_CLOSED', 'El proveedor de RCV ya ha sido cerrado.', 499);
    }

    if (signal.aborted) {
      throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
    }

    if (this.currentSession) {
      return this.currentSession;
    }

    if (!this.sessionPromise) {
      this.sessionPromise = (async () => {
        const session = await BrowserSession.start({
          ...(this.config.chromePath ? { chromePath: this.config.chromePath } : {}),
          headless: this.config.headless,
        });

        if (this.isClosed || signal.aborted) {
          await session.close().catch(() => {});
          throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
        }

        this.currentSession = session;
        return session;
      })();
    }

    return await this.sessionPromise;
  }

  /**
   * Ejecuta la captura individual de un registro (Compras o Ventas).
   * Asegura que los resultados estén cargados (una sola consulta si ya está cargada la UI),
   * re-verifica el período y pestaña activa antes de la descarga,
   * y distingue falta de botón de descarga vs timeout vs fallo genérico (fail-closed).
   */
  private async captureRcvTab(
    session: BrowserSession,
    tabName: 'Compras' | 'Ventas',
    signal: AbortSignal
  ): Promise<DownloadResult> {
    let currentStage = 'tab_selection';
    try {
      if (signal.aborted) {
        throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499, undefined, { stage: currentStage });
      }

      const targetPeriod: PeriodSelectionOptions = { year: 2026, month: 2 };

      // Flujo determinista por pestaña:
      // (1) Activar la pestaña objetivo;
      // (2) Volver a asegurar/seleccionar el período objetivo (año 2026, mes 02) y pulsar 'Consultar' nuevamente;
      // (3) Esperar de forma acotada a que se renderice el resultado de ESA pestaña;
      // (4) Si es COMPRA y existen subpestañas, asegurar 'Registro' activa (href '#compraRegistro/') antes de inspeccionar;
      // (5) Recién entonces inspeccionar y exigir activeTabConfirmed y periodConfirmed tras la nueva consulta.
      // Render timeout configurable y algo mayor sólo para la espera de render en la pestaña,
      // sin superar el timeout global de operación.
      let configuredRenderTimeout = 25000;
      if (process.env.NODE_ENV === 'test') {
        configuredRenderTimeout = 1000;
      } else if (typeof this.config.tabRenderTimeoutMs === 'number' && this.config.tabRenderTimeoutMs > 0) {
        configuredRenderTimeout = this.config.tabRenderTimeoutMs;
      }

      const safeRenderTimeout = Math.min(
        configuredRenderTimeout,
        Math.max(5000, this.config.operationTimeoutMs - 10000)
      );

      currentStage = 'tab_selection';
      const inspection = await selectAndInspectRcvTab(session.page, tabName, signal, targetPeriod, {
        reconsultPeriod: true,
        requireConsultar: true,
        timeoutMs: safeRenderTimeout,
      });

      // 4. Re-verificar período y confirmación de pestaña activa tras la consulta
      currentStage = 'tab_inspection';
      if (!inspection.periodConfirmed) {
        throw new AppError(
          'RCV_PERIOD_UNCONFIRMED',
          'El período seleccionado en el portal de RCV no corresponde al período consultado.',
          502,
          undefined,
          { stage: 'tab_inspection' }
        );
      }

      if (!inspection.activeTabConfirmed) {
        return {
          status: 'error',
          error: {
            code: 'TAB_ACTIVATION_FAILED',
            message: `No fue posible confirmar la pestaña activa de ${tabName} en el portal de RCV tras los intentos de selección.`,
            stage: 'tab_selection',
            ...(inspection.tabDiagnostic ? { tabDiagnostic: inspection.tabDiagnostic } : {}),
          },
        };
      }

      if (inspection.hasNoMovements) {
        return { status: 'empty' };
      }

      if (!inspection.canDownload) {
        return {
          status: 'error',
          error: {
            code: 'RCV_DOWNLOAD_UNAVAILABLE',
            message: `No se encuentra disponible la opción de descarga de detalles en la pestaña de ${tabName}.`,
            stage: 'tab_inspection',
            ...(inspection.tabDiagnostic ? { tabDiagnostic: inspection.tabDiagnostic } : {}),
          },
        };
      }

      // 5. Gatillar y capturar descarga
      currentStage = 'download_trigger';
      const bytes = await captureDownload({
        downloadsPath: session.downloadsPath,
        page: session.page,
        action: async () => {
          await triggerRcvDownload(session.page, signal);
          currentStage = 'download_capture';
        },
        signal,
        maxBytes: this.config.maxCsvBytes,
      });

      return {
        status: 'downloaded',
        bytes,
      };
    } catch (err: unknown) {
      return this.classifyCaptureError(err, tabName, currentStage);
    }
  }

  /**
   * Clasifica de forma segura cualquier error ocurrido durante la captura de una pestaña,
   * mapeándolo a un código enumerado estable con stage garantizado y sin interpolar
   * mensajes externos ni filtrar datos sensibles (URLs, tokens, contraseñas).
   */
  private classifyCaptureError(
    err: unknown,
    tabName: 'Compras' | 'Ventas',
    currentStage: string
  ): DownloadResult {
    // 1. Si es AppError, preservar su código y stage (o fallback a currentStage)
    if (isAppError(err)) {
      const stage =
        err.stage ??
        (typeof err.details?.stage === 'string' ? err.details.stage : currentStage);

      let code = err.code;
      if (code === 'RCV_PERIOD_CONTROLS_UNVERIFIED') {
        code = 'PERIOD_SELECT_FAILED';
      } else if (code === 'RCV_QUERY_BUTTON_NOT_FOUND') {
        code = 'QUERY_BUTTON_MISSING';
      } else if (code === 'RCV_QUERY_FAILED' || code === 'RCV_QUERY_TIMEOUT') {
        code = 'RESULTS_NOT_RENDERED';
      } else if (code === 'RCV_TAB_NOT_FOUND') {
        code = 'TAB_NOT_FOUND';
      }

      const pubError: PublicError = {
        code,
        message: err.message,
        stage,
      };
      if (err.retryAfterSeconds) {
        pubError.retryAfterSeconds = err.retryAfterSeconds;
      }
      if (code === 'RCV_DOWNLOAD_UNAVAILABLE' || code === 'TAB_ACTIVATION_FAILED') {
        const tabDiag = err.details?.tabDiagnostic as RcvTabDiagnostic | undefined;
        if (tabDiag) {
          pubError.tabDiagnostic = tabDiag;
        }
      }
      return {
        status: 'error',
        error: pubError,
      };
    }

    // 2. Clasificación segura de errores genéricos/no controlados
    // NUNCA interpolar err.message ni datos externos para evitar filtrar tokens, URLs o secretos.
    const errName = typeof (err as { name?: string })?.name === 'string' ? (err as { name?: string }).name! : '';
    const rawMsg = typeof (err as { message?: string })?.message === 'string' ? (err as { message?: string }).message! : '';
    const errCode = typeof (err as { code?: string })?.code === 'string' ? (err as { code?: string }).code! : '';

    const isTimeout =
      errName === 'TimeoutError' ||
      errName.includes('Timeout') ||
      errCode === 'ETIMEDOUT' ||
      rawMsg.includes('Timeout') ||
      rawMsg.includes('timed out') ||
      rawMsg.includes('operation timed out');

    if (isTimeout) {
      return {
        status: 'error',
        error: {
          code: 'TIMEOUT',
          message: `Tiempo de espera agotado durante la etapa de ${currentStage} en ${tabName}.`,
          stage: currentStage,
        },
      };
    }

    const isEvaluateError =
      errName === 'EvaluationError' ||
      rawMsg.includes('page.evaluate') ||
      rawMsg.includes('Evaluation failed') ||
      rawMsg.includes('evaluating a function') ||
      rawMsg.includes('Execution context was destroyed') ||
      rawMsg.includes('Target closed');

    if (isEvaluateError) {
      return {
        status: 'error',
        error: {
          code: 'EVALUATE_FAILED',
          message: `Fallo durante la evaluación en página en la etapa de ${currentStage} para ${tabName}.`,
          stage: currentStage,
        },
      };
    }

    // Marcadores propios o clasificaciones derivadas del stage
    let mappedCode = 'CAPTURE_FAILED';
    let mappedMessage = `Fallo durante la captura de ${tabName}.`;

    if (
      currentStage === 'period_selection' ||
      rawMsg.toLowerCase().includes('select') ||
      rawMsg.toLowerCase().includes('periodo')
    ) {
      mappedCode = 'PERIOD_SELECT_FAILED';
      mappedMessage = `Fallo en la selección de período para ${tabName}.`;
    } else if (
      currentStage === 'query_button' ||
      rawMsg.toLowerCase().includes('consultar')
    ) {
      mappedCode = 'QUERY_BUTTON_MISSING';
      mappedMessage = `No fue posible activar el botón de consulta para ${tabName}.`;
    } else if (
      currentStage === 'results_render' ||
      currentStage === 'ensure_results'
    ) {
      mappedCode = 'RESULTS_NOT_RENDERED';
      mappedMessage = `Los resultados no fueron renderizados para ${tabName}.`;
    } else if (
      currentStage === 'tab_selection' ||
      rawMsg.toLowerCase().includes('tab') ||
      rawMsg.toLowerCase().includes('pestaña')
    ) {
      mappedCode = 'TAB_NOT_FOUND';
      mappedMessage = `Pestaña de ${tabName} no encontrada.`;
    } else if (
      currentStage === 'download_trigger' ||
      rawMsg.toLowerCase().includes('descargar')
    ) {
      mappedCode = 'DOWNLOAD_TRIGGER_FAILED';
      mappedMessage = `Fallo al detonar la descarga de ${tabName}.`;
    }

    return {
      status: 'error',
      error: {
        code: mappedCode,
        message: mappedMessage,
        stage: currentStage,
      },
    };
  }

  /**
   * Ejecuta la autenticación si la página actual corresponde a una pantalla de inicio de sesión.
   */
  private async ensureAuthenticated(
    session: BrowserSession,
    credentials: Credentials,
    signal: AbortSignal
  ): Promise<void> {
    const currentUrl = await session.page.url();
    const isLoginRequired =
      currentUrl.includes('IngresoRutClave.html') ||
      currentUrl.includes('zeusr.sii.cl') ||
      currentUrl.includes('accounts.claveunica.gob.cl');

    if (!isLoginRequired) {
      return;
    }

    if (credentials.authMode === 'tributaria') {
      if (session.page.waitForSelector) {
        await session.page.waitForSelector('#rutcntr', { timeout: 15000 }).catch(() => {});
      }
      await authenticateTributaria({
        page: session.page,
        rut: credentials.rut,
        password: credentials.password,
        guard: this.guard,
        signal,
      });
    } else if (credentials.authMode === 'clave-unica') {
      if (session.page.waitForSelector) {
        await session.page.waitForSelector('#myHref, #login-form', { timeout: 15000 }).catch(() => {});
      }
      await authenticateClaveUnica({
        page: session.page,
        rut: credentials.rut,
        password: credentials.password,
        guard: this.guard,
        signal,
      });
    }

    const postLoginUrl = await session.page.url();
    if (!postLoginUrl.includes('consdcvinternetui')) {
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
  }

  /**
   * Implementación de fetch requerida por el contrato RcvProvider.
   */
  public async fetch(credentials: Credentials, signal: AbortSignal): Promise<RcvDownloads> {
    if (this.isClosed) {
      throw new AppError('PROVIDER_CLOSED', 'El proveedor de RCV ya ha sido cerrado.', 499);
    }

    if (signal.aborted) {
      throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
    }

    // Comprobar estado del guard (sin reservar todavía)
    this.guard.assertAllowed();

    // Listener para abortar de inmediato si se cancela la señal externa
    const abortListener = () => {
      this.close().catch(() => {});
    };
    signal.addEventListener('abort', abortListener, { once: true });

    let session: BrowserSession | undefined;

    try {
      session = await this.getOrCreateSession(signal);

      // 1. Navegación directa al portal de RCV con espera acotada de domcontentloaded y timeout de 30s
      await session.page.goto(RCV_PORTAL_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      const initialUrl = await session.page.url();
      if (initialUrl.startsWith('chrome-error://')) {
        throw new AppError(
          'NAVIGATION_ERROR',
          'El navegador no pudo conectar con el portal del SII debido a un error de red o resolución DNS.',
          502
        );
      }

      await boundedHumanDelay(300, 600, signal);

      // 2. Si nos encontramos en la pantalla de login, ejecutar la estrategia de autenticación correspondiente
      await this.ensureAuthenticated(session, credentials, signal);

      // 3. Verificación positiva de identidad del contribuyente activo
      const identity = await verifyActiveContributorIdentity(session.page, credentials.rut, signal, 15000);
      if (!identity.verified) {
        throw new AppError(
          'SESSION_UNVERIFIED',
          'No fue posible verificar la identidad del contribuyente activo en la sesión del RCV.',
          401
        );
      }

      // 4. Capturar secuencialmente Compras y Ventas de forma aislada
      // (cada captura verifica y asegura independientemente el período antes de la descarga)
      const comprasDownload = await this.captureRcvTab(session, 'Compras', signal);

      await boundedHumanDelay(400, 700, signal);

      const ventasDownload = await this.captureRcvTab(session, 'Ventas', signal);

      return {
        compras: comprasDownload,
        ventas: ventasDownload,
      };
    } finally {
      signal.removeEventListener('abort', abortListener);
    }
  }

  /**
   * Cierre seguro e idempotente de la sesión y recursos subyacentes.
   */
  public async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;

    try {
      if (this.sessionPromise) {
        const session = await this.sessionPromise.catch(() => null);
        if (session) {
          await session.close().catch(() => {});
        }
      } else if (this.currentSession) {
        await this.currentSession.close().catch(() => {});
      }
    } finally {
      this.currentSession = null;
      this.sessionPromise = null;
    }
  }
}
