import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../domain/errors.js';
import { SiiPageLike } from './siiPage.js';
import { collectExistingDataUris, extractNewDataUri, ExtractDataUriResult } from './rcvNavigation.js';

export interface CaptureDownloadOptions {
  downloadsPath: string;
  action: () => Promise<void>;
  page?: SiiPageLike;
  signal?: AbortSignal;
  maxBytes?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  dataUriTimeoutMs?: number;
}

/**
 * Limpia el directorio de descargas de manera estricta asegurando que esté vacío.
 */
async function cleanDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    await fs.rm(fullPath, { recursive: true, force: true });
  }
}

/**
 * Decodifica una secuencia con caracteres percent-encoded de forma segura sin lanzar URIError.
 */
function decodeUriSafe(input: string): string {
  return input.replace(/%([0-9a-fA-F]{2})/g, (_, hex) => {
    try {
      return decodeURIComponent(`%${hex}`);
    } catch {
      return String.fromCharCode(parseInt(hex, 16));
    }
  });
}

/**
 * Convierte un Data URI de CSV a Uint8Array, aplicando validación de tamaño maxBytes
 * ANTES de materializar el buffer/string en memoria si la longitud estimada excede el límite.
 * Respeta el charset indicado en la cabecera (default utf-8).
 * NUNCA incluye el contenido del Data URI en mensajes de error o logs.
 */
export function parseDataUriToBytes(dataUri: string, maxBytes = 10 * 1024 * 1024): Uint8Array {
  if (!dataUri.startsWith('data:')) {
    throw new AppError('DOWNLOAD_INVALID', 'El enlace no corresponde a un formato Data URI válido.', 502);
  }

  const commaIdx = dataUri.indexOf(',');
  if (commaIdx === -1) {
    throw new AppError('DOWNLOAD_INVALID', 'Formato Data URI inválido: delimitador no encontrado.', 502);
  }

  const header = dataUri.slice(0, commaIdx).toLowerCase();
  const rawData = dataUri.slice(commaIdx + 1);

  // Extraer charset (por defecto utf-8)
  const charsetMatch = header.match(/charset=([^;]+)/i);
  const charset = charsetMatch ? charsetMatch[1]!.trim().toLowerCase() : 'utf-8';

  const isBase64 = header.includes(';base64');

  if (isBase64) {
    const approxBytes = Math.floor((rawData.length * 3) / 4);
    if (approxBytes > maxBytes) {
      throw new AppError(
        'CSV_TOO_LARGE',
        `El archivo descargado excede el tamaño máximo permitido de ${Math.round(maxBytes / 1024 / 1024)} MB.`,
        502
      );
    }
    const buf = Buffer.from(rawData, 'base64');
    if (buf.length > maxBytes) {
      throw new AppError(
        'CSV_TOO_LARGE',
        `El archivo descargado excede el tamaño máximo permitido de ${Math.round(maxBytes / 1024 / 1024)} MB.`,
        502
      );
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  // URL-encoded data URI
  // Validación de tamaño ANTES de materializar:
  // En codificación por porcentaje, cada %XX son 3 caracteres que decodifican a 1 byte (reducción de 2 caracteres).
  let percentCount = 0;
  for (let i = 0; i < rawData.length; i++) {
    if (rawData.charCodeAt(i) === 37) { // '%'
      percentCount++;
    }
  }
  const decodedByteCount = rawData.length - (percentCount * 2);

  if (decodedByteCount > maxBytes) {
    throw new AppError(
      'CSV_TOO_LARGE',
      `El archivo descargado excede el tamaño máximo permitido de ${Math.round(maxBytes / 1024 / 1024)} MB.`,
      502
    );
  }

  if (charset === 'iso-8859-1' || charset === 'latin1' || charset === 'windows-1252') {
    const bytes = new Uint8Array(decodedByteCount);
    let byteIdx = 0;
    for (let i = 0; i < rawData.length; i++) {
      if (rawData.charCodeAt(i) === 37 && i + 2 < rawData.length) {
        const hex = rawData.slice(i + 1, i + 3);
        const parsed = parseInt(hex, 16);
        if (!Number.isNaN(parsed)) {
          bytes[byteIdx++] = parsed;
          i += 2;
          continue;
        }
      }
      bytes[byteIdx++] = rawData.charCodeAt(i) & 0xff;
    }
    const finalBytes = bytes.subarray(0, byteIdx);
    if (finalBytes.length > maxBytes) {
      throw new AppError(
        'CSV_TOO_LARGE',
        `El archivo descargado excede el tamaño máximo permitido de ${Math.round(maxBytes / 1024 / 1024)} MB.`,
        502
      );
    }
    return finalBytes;
  }

  // UTF-8
  let decodedText: string;
  try {
    decodedText = decodeURIComponent(rawData);
  } catch {
    decodedText = decodeUriSafe(rawData);
  }

  const buf = Buffer.from(decodedText, 'utf-8');
  if (buf.length > maxBytes) {
    throw new AppError(
      'CSV_TOO_LARGE',
      `El archivo descargado excede el tamaño máximo permitido de ${Math.round(maxBytes / 1024 / 1024)} MB.`,
      502
    );
  }

  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * captureDownload
 * Ejecuta una acción que detona la obtención del archivo CSV de RCV:
 * 1. Prioriza la detección de un nuevo Data URI en el DOM (mecanismo real del portal SII).
 * 2. Si no aparece ningún Data URI tras un tiempo acotado, recurre al mecanismo de archivo en downloadsPath.
 */
export async function captureDownload(options: CaptureDownloadOptions): Promise<Uint8Array> {
  const {
    downloadsPath,
    action,
    page,
    signal,
    maxBytes = 10 * 1024 * 1024,
    pollIntervalMs = 150,
    timeoutMs = 45000,
    dataUriTimeoutMs = process.env.NODE_ENV === 'test' ? 400 : 5000,
  } = options;

  if (signal?.aborted) {
    throw signal.reason || new AppError('OPERATION_ABORTED', 'La operación de descarga fue cancelada.', 499);
  }

  // 1. Snapshot previo de data URIs existentes en el DOM (para no tomar uno de una pestaña previa)
  let priorHrefs: string[] = [];
  if (page) {
    try {
      priorHrefs = await collectExistingDataUris(page);
    } catch {
      priorHrefs = [];
    }
  }

  // 2. Limpiar directorio antes de la acción
  await cleanDirectory(downloadsPath);

  // 3. Ejecutar la acción que gatilla la descarga o creación del Data URI
  await action();

  // 4. Mecanismo prioritario: esperar de forma acotada a que aparezca un nuevo Data URI en el DOM
  if (page) {
    const dataUriStartTime = Date.now();
    while (Date.now() - dataUriStartTime < dataUriTimeoutMs) {
      if (signal?.aborted) {
        throw signal.reason || new AppError('OPERATION_ABORTED', 'La operación de descarga fue cancelada.', 499);
      }

      let dataUriResult: ExtractDataUriResult | null = null;
      try {
        dataUriResult = await extractNewDataUri(page, priorHrefs, maxBytes);
      } catch {
        dataUriResult = null;
      }

      if (dataUriResult?.found) {
        if (dataUriResult.tooLarge) {
          throw new AppError(
            'CSV_TOO_LARGE',
            `El archivo descargado excede el tamaño máximo permitido de ${Math.round(maxBytes / 1024 / 1024)} MB.`,
            502
          );
        }
        if (dataUriResult.href) {
          return parseDataUriToBytes(dataUriResult.href, maxBytes);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  // 5. Mecanismo alternativo: Polling de archivo en downloadsPath
  const startTime = Date.now();
  let lastSize = -1;
  let stableCount = 0;
  let targetFileName: string | undefined;

  while (Date.now() - startTime < timeoutMs) {
    if (signal?.aborted) {
      throw signal.reason || new AppError('OPERATION_ABORTED', 'La operación de descarga fue cancelada.', 499);
    }

    const entries = await fs.readdir(downloadsPath);
    const crdownloads = entries.filter((f) => f.endsWith('.crdownload') || f.endsWith('.tmp'));
    const candidateFiles = entries.filter(
      (f) => !f.endsWith('.crdownload') && !f.endsWith('.tmp') && !f.startsWith('.')
    );

    if (candidateFiles.length > 1) {
      throw new AppError(
        'DOWNLOAD_AMBIGUOUS',
        'Se detectaron múltiples archivos inesperados en el directorio de descargas.',
        502
      );
    }

    if (candidateFiles.length === 1 && crdownloads.length === 0) {
      const fileName = candidateFiles[0]!;
      const fullPath = path.join(downloadsPath, fileName);
      const stats = await fs.lstat(fullPath);

      if (stats.isSymbolicLink()) {
        throw new AppError('DOWNLOAD_INVALID', 'El archivo descargado no puede ser un enlace simbólico.', 502);
      }

      if (stats.size > maxBytes) {
        throw new AppError(
          'CSV_TOO_LARGE',
          `El archivo descargado excede el tamaño máximo permitido de ${Math.round(maxBytes / 1024 / 1024)} MB.`,
          502
        );
      }

      if (stats.size >= 0 && stats.size === lastSize) {
        stableCount++;
        if (stableCount >= 2) {
          targetFileName = fileName;
          break;
        }
      } else {
        lastSize = stats.size;
        stableCount = 0;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  if (!targetFileName) {
    throw new AppError(
      'DOWNLOAD_TIMEOUT',
      `Tiempo de espera de descarga agotado (${Math.round(timeoutMs / 1000)}s) o archivo incompleto.`,
      504
    );
  }

  const finalPath = path.join(downloadsPath, targetFileName);
  const buffer = await fs.readFile(finalPath);

  if (buffer.length > maxBytes) {
    throw new AppError(
      'CSV_TOO_LARGE',
      `El archivo descargado excede el tamaño máximo permitido de ${Math.round(maxBytes / 1024 / 1024)} MB.`,
      502
    );
  }

  return new Uint8Array(buffer);
}
