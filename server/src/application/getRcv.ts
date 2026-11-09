import {
  Credentials,
  RCV_PERIOD,
  RcvRecord,
  RcvResult,
  RcvTable,
  RcvTabDiagnostic,
} from '../../../shared/rcv.js';
import { AppError } from '../domain/errors.js';
import {
  DownloadResult,
  RcvDownloads,
  RcvProvider,
} from '../domain/rcvProvider.js';
import { parseRcvCsv, ParseRcvCsvLimits } from '../infrastructure/csv/parseRcvCsv.js';

export interface RcvAggregateRecordDiagnostic {
  status: 'ok' | 'empty' | 'error';
  count: number | null;
  error?: string;
  stage?: string;
  tabDiagnostic?: RcvTabDiagnostic;
}

export interface RcvAggregateDiagnostic {
  compras: RcvAggregateRecordDiagnostic;
  ventas: RcvAggregateRecordDiagnostic;
}

export interface RcvFetchFailedDetails {
  comprasCode?: string;
  ventasCode?: string;
  comprasStage?: string;
  ventasStage?: string;
  comprasTabDiagnostic?: RcvTabDiagnostic;
  ventasTabDiagnostic?: RcvTabDiagnostic;
  [key: string]: unknown;
}

export interface ExecuteGetRcvOptions {
  limits?: ParseRcvCsvLimits;
  onDiagnostic?: (diagnostic: RcvAggregateDiagnostic) => void;
}

function processDownloadResult(
  kind: 'Compras' | 'Ventas',
  download: DownloadResult,
  limits?: ParseRcvCsvLimits
): RcvRecord {
  if (download.status === 'empty') {
    const emptyTable: RcvTable = {
      status: 'empty',
      columns: [],
      rows: [],
    };
    return emptyTable;
  }

  if (download.status === 'error') {
    return {
      status: 'error',
      error: download.error,
    };
  }

  // download.status === 'downloaded'
  try {
    const table = parseRcvCsv(download.bytes, limits);
    return table;
  } catch (err: unknown) {
    if (err instanceof AppError) {
      // Preservar código de error específico y tipado de CSV (CSV_HTML_RECEIVED, CSV_ZIP_RECEIVED, CSV_EMPTY, CSV_ENCODING_INVALID, CSV_STRUCTURE_INVALID, CSV_TOO_LARGE, etc.)
      return {
        status: 'error',
        error: {
          code: err.code,
          message: `Error al procesar el archivo CSV de ${kind}: ${err.message}`,
        },
      };
    }
    return {
      status: 'error',
      error: {
        code: 'RCV_CSV_ERROR',
        message: `Error inesperado al decodificar el archivo CSV de ${kind}.`,
      },
    };
  }
}

function getRecordCount(record: RcvRecord): number | null {
  if (record.status === 'ok') {
    return record.rows.length;
  }
  if (record.status === 'empty') {
    return 0;
  }
  return null;
}

function buildRecordDiagnostic(record: RcvRecord): RcvAggregateRecordDiagnostic {
  const count = getRecordCount(record);
  if (record.status === 'error') {
    return {
      status: 'error',
      count,
      error: record.error.code,
      ...(record.error.stage ? { stage: record.error.stage } : {}),
      ...(record.error.tabDiagnostic ? { tabDiagnostic: record.error.tabDiagnostic } : {}),
    };
  }
  return {
    status: record.status,
    count,
  };
}

/**
 * executeGetRcv
 * Orquesta la consulta al RcvProvider para el periodo fijo Febrero 2026.
 * Convierte los RcvDownloads en RcvResult mediante parseRcvCsv.
 *
 * Reglas de negocio:
 * - Si ambos fallan (status === 'error'), lanza AppError 502.
 * - Si uno tiene éxito ('ok' o 'empty') y el otro falla ('error'), el resultado global es 'partial'.
 * - Si ambos tienen éxito ('ok' o 'empty'), el resultado global es 'complete'.
 * - Garantiza cierre del provider en bloque finally del invocador.
 */
export async function executeGetRcv(
  provider: RcvProvider,
  credentials: Credentials,
  signal: AbortSignal,
  options?: ExecuteGetRcvOptions
): Promise<RcvResult> {
  const downloads: RcvDownloads = await provider.fetch(credentials, signal);

  const comprasRecord = processDownloadResult('Compras', downloads.compras, options?.limits);
  const ventasRecord = processDownloadResult('Ventas', downloads.ventas, options?.limits);

  const diagnostic: RcvAggregateDiagnostic = {
    compras: buildRecordDiagnostic(comprasRecord),
    ventas: buildRecordDiagnostic(ventasRecord),
  };

  options?.onDiagnostic?.(diagnostic);

  // Si ambos fallaron con error, se considera fallo completo de la obtención
  if (comprasRecord.status === 'error' && ventasRecord.status === 'error') {
    throw new AppError(
      'RCV_FETCH_FAILED',
      'No fue posible obtener los registros de Compras ni Ventas.',
      502,
      undefined,
      {
        comprasCode: comprasRecord.error.code,
        ventasCode: ventasRecord.error.code,
        ...(comprasRecord.error.stage ? { comprasStage: comprasRecord.error.stage } : {}),
        ...(ventasRecord.error.stage ? { ventasStage: ventasRecord.error.stage } : {}),
        ...(comprasRecord.error.tabDiagnostic ? { comprasTabDiagnostic: comprasRecord.error.tabDiagnostic } : {}),
        ...(ventasRecord.error.tabDiagnostic ? { ventasTabDiagnostic: ventasRecord.error.tabDiagnostic } : {}),
      }
    );
  }

  const isPartial = comprasRecord.status === 'error' || ventasRecord.status === 'error';

  return {
    period: RCV_PERIOD,
    status: isPartial ? 'partial' : 'complete',
    compras: comprasRecord,
    ventas: ventasRecord,
  };
}
