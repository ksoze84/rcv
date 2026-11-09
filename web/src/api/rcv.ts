import { z } from 'zod';
import type { Credentials, PublicError, RcvResult } from '../../../shared/rcv.js';

export interface RcvApiSuccess {
  ok: true;
  data: RcvResult;
}

export interface RcvApiFailure {
  ok: false;
  status: number;
  error: PublicError;
}

export type RcvApiResponse = RcvApiSuccess | RcvApiFailure;

export const DEFAULT_TIMEOUT_MS = 260_000;

const tabDiagnosticSchema = z.object({
  activeTabConfirmed: z.boolean(),
  periodConfirmed: z.boolean(),
  subtabRegistroFound: z.boolean(),
  subtabRegistroActive: z.boolean(),
  downloadButtonsFound: z.number(),
  detalleButtonFound: z.boolean(),
  detalleButtonVisible: z.boolean(),
  tableCount: z.number(),
  noMovementsPatternFound: z.boolean(),
  consultarClicked: z.boolean(),
  hashEndsWith: z.string(),
  elapsedMsInTab: z.number(),
  downloadButtonLabels: z.array(z.string()).optional(),
  detalleRejectedByOppositeContainer: z.boolean().optional(),
  detalleRejectedByVisibility: z.boolean().optional(),
  detalleRejectedBySubtabFilter: z.boolean().optional(),
});

const publicErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  stage: z.string().optional(),
  retryAfterSeconds: z.number().optional(),
  tabDiagnostic: tabDiagnosticSchema.optional(),
});

const rcvRecordSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string())),
  }),
  z.object({
    status: z.literal('empty'),
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string())),
  }),
  z.object({
    status: z.literal('error'),
    error: publicErrorSchema,
  }),
]);

export const rcvResultSchema = z.object({
  period: z.object({
    year: z.literal(2026),
    month: z.literal(2),
  }),
  status: z.enum(['complete', 'partial']),
  compras: rcvRecordSchema,
  ventas: rcvRecordSchema,
});

/**
 * Realiza la petición POST a /api/rcv con las credenciales dadas.
 * Maneja AbortSignal (externo o por timeout de margen 260.000 ms).
 * Garantiza nunca registrar contraseñas ni datos sensibles en log.
 */
export async function fetchRcv(
  credentials: Credentials,
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<RcvApiResponse> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(new DOMException('Tiempo de espera agotado (260s)', 'TimeoutError'));
  }, timeoutMs);

  // Combinar la señal externa si existe
  const externalSignal = options?.signal;
  const onExternalAbort = () => {
    timeoutController.abort(externalSignal?.reason);
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      throw externalSignal.reason;
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const response = await fetch('/api/rcv', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(credentials),
      signal: timeoutController.signal,
    });

    const isJson = response.headers.get('content-type')?.includes('application/json');
    const jsonBody = isJson ? await response.json().catch(() => null) : null;

    if (!response.ok) {
      let retryAfterSeconds: number | undefined;
      const retryHeader = response.headers.get('retry-after');
      if (retryHeader) {
        const parsed = parseInt(retryHeader, 10);
        if (!isNaN(parsed) && parsed > 0) {
          retryAfterSeconds = parsed;
        }
      }

      if (jsonBody && typeof jsonBody === 'object') {
        const bodyError = (jsonBody as { error?: PublicError }).error;
        if (bodyError && typeof bodyError.message === 'string') {
          const resolvedRetryAfter = bodyError.retryAfterSeconds ?? retryAfterSeconds;
          return {
            ok: false,
            status: response.status,
            error: {
              code: bodyError.code || `HTTP_${response.status}`,
              message: bodyError.message,
              ...(resolvedRetryAfter !== undefined ? { retryAfterSeconds: resolvedRetryAfter } : {}),
            },
          };
        }
      }

      const defaultMessage =
        response.status === 429
          ? 'Demasiadas solicitudes. Por favor espere antes de intentar nuevamente.'
          : response.status === 501
            ? 'Servicio no disponible temporalmente en el servidor.'
            : `Error en la solicitud al servidor (${response.status}).`;

      return {
        ok: false,
        status: response.status,
        error: {
          code: `HTTP_${response.status}`,
          message: defaultMessage,
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        },
      };
    }

    if (!isJson || jsonBody === null || typeof jsonBody !== 'object') {
      throw new Error('Respuesta inválida del servidor (formato no reconocido).');
    }

    const validationResult = rcvResultSchema.safeParse(jsonBody);
    if (!validationResult.success) {
      throw new Error('Estructura de respuesta inesperada del servidor.');
    }

    return {
      ok: true,
      data: validationResult.data as RcvResult,
    };
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}
