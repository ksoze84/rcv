import { parse } from 'csv-parse/sync';
import { RcvTable } from '../../../../shared/rcv.js';
import { AppError } from '../../domain/errors.js';

export interface ParseRcvCsvLimits {
  maxCsvBytes?: number;
  maxCsvRows?: number;
}

const DEFAULT_MAX_CSV_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_MAX_CSV_ROWS = 20_000;
const MAX_RECORD_SIZE = 1024 * 1024; // 1 MiB

const ERROR_CSV_EMPTY = 'El archivo CSV está vacío.';
const ERROR_CSV_TOO_LARGE = 'El archivo CSV supera los límites permitidos.';
const ERROR_CSV_HTML_RECEIVED = 'La respuesta recibida corresponde a una página HTML y no a un archivo CSV.';
const ERROR_CSV_ZIP_RECEIVED = 'El archivo recibido corresponde a un archivo comprimido (ZIP) y no a un CSV.';
const ERROR_CSV_ENCODING_INVALID = 'El archivo recibido no pudo ser decodificado con una codificación de texto válida.';
const ERROR_CSV_STRUCTURE_INVALID = 'El archivo no presenta un delimitador ni estructura CSV válida.';

function decodeBytesToString(bytes: Uint8Array): string {
  // Manejo de UTF-8 BOM (0xEF, 0xBB, 0xBF)
  let slice = bytes;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    slice = bytes.subarray(3);
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    // UTF-16 LE BOM
    try {
      const utf16LeDecoder = new TextDecoder('utf-16le', { fatal: true });
      return utf16LeDecoder.decode(bytes.subarray(2));
    } catch {
      throw new AppError('CSV_ENCODING_INVALID', ERROR_CSV_ENCODING_INVALID, 400);
    }
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // UTF-16 BE BOM
    try {
      const utf16BeDecoder = new TextDecoder('utf-16be', { fatal: true });
      return utf16BeDecoder.decode(bytes.subarray(2));
    } catch {
      throw new AppError('CSV_ENCODING_INVALID', ERROR_CSV_ENCODING_INVALID, 400);
    }
  }

  // Intentar decodificar como UTF-8 estricto (fatal: true)
  try {
    const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
    return utf8Decoder.decode(slice);
  } catch {
    // Si falla UTF-8 estricto, verificar si es Windows-1252 válido
    // En el estándar Windows-1252 (CP1252), los bytes 0x81, 0x8D, 0x8F, 0x90, 0x9D no están asignados
    const hasUnassignedCp1252 = slice.some(
      (b) => b === 0x81 || b === 0x8d || b === 0x8f || b === 0x90 || b === 0x9d
    );

    if (hasUnassignedCp1252) {
      throw new AppError('CSV_ENCODING_INVALID', ERROR_CSV_ENCODING_INVALID, 400);
    }

    try {
      const fallbackDecoder = new TextDecoder('windows-1252', { fatal: true });
      return fallbackDecoder.decode(slice);
    } catch {
      throw new AppError('CSV_ENCODING_INVALID', ERROR_CSV_ENCODING_INVALID, 400);
    }
  }
}

function detectBinaryOrHtmlJson(text: string, bytes: Uint8Array): void {
  // Detección de binarios conocidos: firma PK (ZIP / XLSX / DOCX / comprimidos)
  if (
    bytes.length >= 2 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b
  ) {
    throw new AppError('CSV_ZIP_RECEIVED', ERROR_CSV_ZIP_RECEIVED, 400);
  }

  // Detección de caracteres nulos (indicio de binario)
  if (text.includes('\0')) {
    throw new AppError('CSV_STRUCTURE_INVALID', ERROR_CSV_STRUCTURE_INVALID, 400);
  }

  // Detección de HTML de error / sesión / portal
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('<!doctype html') ||
    lower.startsWith('<html') ||
    lower.startsWith('<?xml') ||
    lower.startsWith('<!doctype') ||
    lower.startsWith('<head') ||
    lower.startsWith('<body') ||
    /^\s*<(!doctype|html|head|body|div|script)/i.test(trimmed)
  ) {
    throw new AppError('CSV_HTML_RECEIVED', ERROR_CSV_HTML_RECEIVED, 400);
  }

  // Detección de JSON de error / login
  if (
    (lower.startsWith('{') && lower.endsWith('}')) ||
    (lower.startsWith('[') && lower.endsWith(']'))
  ) {
    throw new AppError('CSV_STRUCTURE_INVALID', ERROR_CSV_STRUCTURE_INVALID, 400);
  }
}

interface DelimiterCandidateResult {
  delimiter: ';' | ',';
  records: string[][];
  headerCount: number;
}

function resolveDelimiterCandidate(text: string): DelimiterCandidateResult {
  const candidateSemi = parseWithDelimiter(text, ';');
  const candidateComma = parseWithDelimiter(text, ',');

  if (candidateSemi && candidateComma) {
    if (candidateSemi.headerCount > candidateComma.headerCount) {
      return candidateSemi;
    }
    if (candidateComma.headerCount > candidateSemi.headerCount) {
      return candidateComma;
    }
    throw new AppError('CSV_STRUCTURE_INVALID', ERROR_CSV_STRUCTURE_INVALID, 400);
  }

  if (candidateSemi) {
    return candidateSemi;
  }
  if (candidateComma) {
    return candidateComma;
  }

  throw new AppError('CSV_STRUCTURE_INVALID', ERROR_CSV_STRUCTURE_INVALID, 400);
}

function parseWithDelimiter(
  text: string,
  delimiter: ';' | ','
): DelimiterCandidateResult | null {
  try {
    const records = parse(text, {
      delimiter,
      record_delimiter: ['\r\n', '\n', '\r'],
      relax_column_count: true,
      skip_empty_lines: true,
      max_record_size: MAX_RECORD_SIZE,
    }) as string[][];

    if (!records || records.length === 0) {
      return null;
    }

    const header = records[0];
    if (!header || header.length < 2) {
      return null;
    }

    // Al menos 2 encabezados deben tener contenido significativo (no solo campos vacios o espacios)
    const significantHeaders = header.filter((h) => h.trim().length > 0);
    if (significantHeaders.length < 2) {
      return null;
    }

    return {
      delimiter,
      records,
      headerCount: header.length,
    };
  } catch (err: unknown) {
    if (err instanceof AppError) {
      throw err;
    }
    return null;
  }
}

export function parseRcvCsv(
  bytes: Uint8Array,
  limits?: ParseRcvCsvLimits
): RcvTable {
  const maxCsvBytes = limits?.maxCsvBytes ?? DEFAULT_MAX_CSV_BYTES;
  const maxCsvRows = limits?.maxCsvRows ?? DEFAULT_MAX_CSV_ROWS;

  if (bytes.length === 0) {
    throw new AppError('CSV_EMPTY', ERROR_CSV_EMPTY, 400);
  }

  if (bytes.length > maxCsvBytes) {
    throw new AppError('CSV_TOO_LARGE', ERROR_CSV_TOO_LARGE, 400);
  }

  // Comprobar binario ZIP/PK antes de decodificar texto
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    throw new AppError('CSV_ZIP_RECEIVED', ERROR_CSV_ZIP_RECEIVED, 400);
  }

  const text = decodeBytesToString(bytes);

  if (text.trim().length === 0) {
    throw new AppError('CSV_EMPTY', ERROR_CSV_EMPTY, 400);
  }

  detectBinaryOrHtmlJson(text, bytes);

  const chosenCandidate = resolveDelimiterCandidate(text);

  const allRecords = chosenCandidate.records;
  const headerRecord = allRecords[0];
  if (!headerRecord || headerRecord.length < 2) {
    throw new AppError('CSV_STRUCTURE_INVALID', ERROR_CSV_STRUCTURE_INVALID, 400);
  }

  const dataRows = allRecords.slice(1);

  if (dataRows.length > maxCsvRows) {
    throw new AppError('CSV_TOO_LARGE', ERROR_CSV_TOO_LARGE, 400);
  }

  let maxColumns = headerRecord.length;
  for (const row of dataRows) {
    if (row.length > maxColumns) {
      maxColumns = row.length;
    }
  }

  const columns = [...headerRecord];
  for (let i = headerRecord.length; i < maxColumns; i++) {
    columns.push(`Columna ${i + 1}`);
  }

  const normalizedRows = dataRows.map((row) => {
    if (row.length === maxColumns) {
      return row;
    }
    const padded = [...row];
    while (padded.length < maxColumns) {
      padded.push('');
    }
    return padded;
  });

  return {
    status: normalizedRows.length > 0 ? 'ok' : 'empty',
    columns,
    rows: normalizedRows,
  };
}
