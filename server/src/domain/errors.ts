import { PublicError, RcvTabDiagnostic } from '../../../shared/rcv.js';

export interface AppErrorDetails {
  stage?: string;
  comprasCode?: string;
  ventasCode?: string;
  comprasStage?: string;
  ventasStage?: string;
  tabDiagnostic?: RcvTabDiagnostic;
  comprasTabDiagnostic?: RcvTabDiagnostic;
  ventasTabDiagnostic?: RcvTabDiagnostic;
  [key: string]: unknown;
}

export class AppError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;
  public readonly retryAfterSeconds?: number;
  public readonly details?: AppErrorDetails;
  public readonly stage?: string;

  constructor(
    code: string,
    message: string,
    httpStatus: number = 500,
    retryAfterSeconds?: number,
    details?: AppErrorDetails
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    if (typeof retryAfterSeconds === 'number') {
      this.retryAfterSeconds = retryAfterSeconds;
    }
    if (details !== undefined) {
      this.details = details;
      if (typeof details.stage === 'string') {
        this.stage = details.stage;
      }
    }
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * Determina de forma segura y tolerante a entornos mixtos/mock si un error
 * corresponde a una instancia de AppError.
 */
export function isAppError(error: unknown): error is AppError {
  return (
    error instanceof AppError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof (error as { code: unknown }).code === 'string' &&
      'httpStatus' in error)
  );
}

/**
 * Traduce cualquier error a una estructura PublicError segura,
 * evitando propagar trazas, mensajes internos o secretos desconocidos.
 */
export function publicError(error: unknown): PublicError {
  if (error instanceof AppError) {
    const pub: PublicError = {
      code: error.code,
      message: error.message,
    };
    const stage =
      error.stage ??
      (typeof error.details?.stage === 'string' ? error.details.stage : undefined);
    if (stage) {
      pub.stage = stage;
    }
    if (pub.code === 'RCV_DOWNLOAD_UNAVAILABLE' || pub.code === 'TAB_ACTIVATION_FAILED') {
      const tabDiag = error.details?.tabDiagnostic as RcvTabDiagnostic | undefined;
      if (tabDiag) {
        pub.tabDiagnostic = tabDiag;
      }
    }
    if (typeof error.retryAfterSeconds === 'number' && error.retryAfterSeconds > 0) {
      pub.retryAfterSeconds = error.retryAfterSeconds;
    }
    return pub;
  }

  return {
    code: 'INTERNAL_ERROR',
    message: 'Ha ocurrido un error inesperado al procesar la solicitud.',
  };
}
