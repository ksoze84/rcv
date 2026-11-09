import { z } from 'zod';

/**
 * Periodo objetivo fijado por requerimiento del sistema: Febrero de 2026.
 */
export const RCV_PERIOD = {
  year: 2026,
  month: 2,
} as const;

export type AuthMode = 'tributaria' | 'clave-unica';

export interface Credentials {
  rut: string;
  password: string;
  authMode: AuthMode;
}

export interface RcvTabDiagnostic {
  activeTabConfirmed: boolean;
  periodConfirmed: boolean;
  subtabRegistroFound: boolean;
  subtabRegistroActive: boolean;
  downloadButtonsFound: number;
  detalleButtonFound: boolean;
  detalleButtonVisible: boolean;
  tableCount: number;
  noMovementsPatternFound: boolean;
  consultarClicked: boolean;
  hashEndsWith: string;
  elapsedMsInTab: number;
  downloadButtonLabels?: string[];
  detalleRejectedByOppositeContainer?: boolean;
  detalleRejectedByVisibility?: boolean;
  detalleRejectedBySubtabFilter?: boolean;
}

export interface PublicError {
  code: string;
  message: string;
  stage?: string;
  retryAfterSeconds?: number;
  tabDiagnostic?: RcvTabDiagnostic;
}

export interface RcvTable {
  status: 'ok' | 'empty';
  columns: string[];
  rows: string[][];
}

export type RcvRecord = RcvTable | { status: 'error'; error: PublicError };

export interface RcvResult {
  period: typeof RCV_PERIOD;
  status: 'complete' | 'partial';
  compras: RcvRecord;
  ventas: RcvRecord;
}

/**
 * Normaliza un RUT eliminando puntos, espacios y guiones, y convirtiendo a mayusculas.
 * Ejemplos: " 12.345.678-k " -> "12345678-K", "12345678k" -> "12345678-K"
 */
export function normalizeRut(raw: string): string {
  if (typeof raw !== 'string') {
    return '';
  }
  const clean = raw.trim().replaceAll('.', '').replaceAll('-', '').toUpperCase();
  if (clean.length < 2) {
    return clean;
  }
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  return `${body}-${dv}`;
}

/**
 * Valida formato y digito verificador modulo 11 para un RUT chileno.
 */
export function isValidRut(raw: string): boolean {
  const normalized = normalizeRut(raw);
  const match = /^(\d{1,9})-([\dK])$/.exec(normalized);
  if (!match) {
    return false;
  }
  const body = match[1];
  const dv = match[2];
  if (!body || !dv) {
    return false;
  }

  let sum = 0;
  let multiplier = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    const digit = body[i];
    if (digit === undefined) {
      continue;
    }
    sum += Number(digit) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }

  const remainder = 11 - (sum % 11);
  let expectedDv = '';
  if (remainder === 11) {
    expectedDv = '0';
  } else if (remainder === 10) {
    expectedDv = 'K';
  } else {
    expectedDv = String(remainder);
  }

  return dv === expectedDv;
}

/**
 * Esquema Zod estricto para validar credenciales de autenticacion.
 * - rut: normalizado y validado con digito verificador modulo 11.
 * - password: SIN trim (para preservar espacios intencionados), no vacia y con maximo razonable (128 caracteres).
 * - authMode: 'tributaria' o 'clave-unica'.
 */
export const credentialsSchema = z
  .object({
    rut: z
      .string()
      .min(1, 'El RUT es requerido')
      .transform(normalizeRut)
      .refine(isValidRut, { message: 'El RUT o dígito verificador es inválido' }),
    password: z
      .string()
      .min(1, 'La contraseña es requerida')
      .max(128, 'La contraseña excede el largo máximo permitido'),
    authMode: z.enum(['tributaria', 'clave-unica'] as const, {
      message: 'Modo de autenticación inválido',
    }),
  })
  .strict();
