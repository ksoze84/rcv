import { AppError } from '../../domain/errors.js';
import { AuthAttemptGuard } from './authAttemptGuard.js';
import { boundedHumanDelay, parseExactOrigin, pollAuthenticationResult, SiiPageLike } from './siiPage.js';

export interface TributariaAuthParams {
  page: SiiPageLike;
  rut: string;
  password: string;
  guard: AuthAttemptGuard;
  signal?: AbortSignal;
}

const ZEUSR_ALLOWED_ORIGIN = 'https://zeusr.sii.cl';
const TRIBUTARIA_EXPECTED_ACTION_PATH = '/cgi_AUT2000/CAutInicio.cgi';

/**
 * Normaliza el RUT para ingreso en el campo de texto del formulario del SII.
 * En el portal de Clave Tributaria de SII, el campo #rutcntr suele aceptar el RUT
 * con guión y dígito verificador, o sin puntos.
 */
export function formatRutForTributaria(rawRut: string): string {
  return rawRut.trim().replaceAll('.', '').toUpperCase();
}

/**
 * Inspecciona el formulario tributario en el DOM.
 * Ejecutada en el navegador como JS puro serializable.
 */
export function evaluateTributariaFormMeta() {
  const form = document.querySelector('form#myform');
  if (!form) {
    return { exists: false, actionUrl: '', method: '' };
  }
  return {
    exists: true,
    actionUrl: form.action || '', // URL resuelta completa por el navegador
    method: (form.method || '').toLowerCase(),
  };
}

/**
 * Valida de forma estricta que la página actual pertenezca al dominio seguro permitido (https://zeusr.sii.cl exacto, sin credenciales)
 * y que la acción resuelta del formulario apunte a zeusr.sii.cl con método POST y path oficial /cgi_AUT2000/CAutInicio.cgi.
 */
export async function assertTributariaFormSecurity(page: SiiPageLike): Promise<void> {
  const currentUrl = await page.url();
  const parsedPageUrl = parseExactOrigin(currentUrl);

  if (parsedPageUrl?.origin !== ZEUSR_ALLOWED_ORIGIN) {
    throw new AppError(
      'SECURITY_VIOLATION',
      'El formulario de autenticación tributaria no se encuentra en el origen seguro permitido.',
      502
    );
  }

  const formMeta = await page.evaluate<{ exists: boolean; actionUrl: string; method: string }>(
    evaluateTributariaFormMeta
  );

  if (!formMeta.exists) {
    throw new AppError(
      'FORM_NOT_FOUND',
      'No se encontró el formulario oficial de autenticación tributaria (form#myform).',
      502
    );
  }

  if (formMeta.method !== 'post') {
    throw new AppError(
      'SECURITY_VIOLATION',
      'El método del formulario de autenticación tributaria no es POST seguro.',
      502
    );
  }

  const parsedActionUrl = parseExactOrigin(formMeta.actionUrl);
  if (
    parsedActionUrl?.origin !== ZEUSR_ALLOWED_ORIGIN ||
    parsedActionUrl?.pathname !== TRIBUTARIA_EXPECTED_ACTION_PATH
  ) {
    throw new AppError(
      'SECURITY_VIOLATION',
      'La acción del formulario no apunta al destino oficial seguro permitido.',
      502
    );
  }
}

/**
 * authenticateTributaria
 * Ejecuta el flujo estricto de autenticación con Clave Tributaria del SII:
 * 1. Validación de origen y formulario antes de cada rellenado y antes del click.
 * 2. Relleno sin exponer credenciales a logs o IA.
 * 3. Reserva de intento en el guard inmediatamente seguida de verificación de señal y click único (sin reintentos).
 * 4. Polling seguro de resultado y manejo de estados.
 */
export async function authenticateTributaria(params: TributariaAuthParams): Promise<void> {
  const { page, rut, password, guard, signal } = params;

  if (signal?.aborted) {
    throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
  }

  // 1. Validar seguridad del origen y formulario antes de interactuar
  await assertTributariaFormSecurity(page);

  await boundedHumanDelay(250, 450, signal);

  // Re-validar origen y señal antes de rellenar el RUT
  if (signal?.aborted) {
    throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
  }
  await assertTributariaFormSecurity(page);

  const rutInput = page.locator('#rutcntr');
  const formattedRut = formatRutForTributaria(rut);
  await rutInput.fill(formattedRut);

  await boundedHumanDelay(250, 450, signal);

  // Re-validar origen y señal antes de rellenar la clave
  if (signal?.aborted) {
    throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
  }
  await assertTributariaFormSecurity(page);

  const passInput = page.locator('#clave');
  await passInput.fill(password);

  await boundedHumanDelay(250, 450, signal);

  // Re-validar seguridad del formulario justo antes de enviar
  if (signal?.aborted) {
    throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
  }
  await assertTributariaFormSecurity(page);

  // 2. Reservar intento en el guard INMEDIATAMENTE antes del click
  await guard.reserveAttempt(15);

  // Comprobar aborto inmediatamente después de la reserva antes de accionar el click
  if (signal?.aborted) {
    throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
  }

  // 3. Click único en el botón de ingreso (#bt_ingresar) - sin bucles ni reintentos
  const submitButton = page.locator('#bt_ingresar');
  await submitButton.click();

  // 4. Esperar y sondear resultado
  const authResult = await pollAuthenticationResult(page, signal);

  if (authResult.state === 'account_blocked') {
    guard.markBlocked(Math.max(authResult.retryAfterSeconds || 1800, 1800));
    throw new AppError(
      'ACCOUNT_BLOCKED',
      authResult.message || 'La cuenta o portal se encuentra temporalmente bloqueado.',
      429,
      Math.max(authResult.retryAfterSeconds || 1800, 1800)
    );
  }

  if (authResult.state === 'challenge_required') {
    throw new AppError(
      'CHALLENGE_REQUIRED',
      authResult.message || 'Se requiere completar un desafío de seguridad interactivo en el portal.',
      403
    );
  }

  if (authResult.state === 'invalid_credentials') {
    throw new AppError(
      'INVALID_CREDENTIALS',
      authResult.message || 'Las credenciales tributarias ingresadas son incorrectas.',
      401
    );
  }

  // Si authResult.state === 'redirected', retorna void para que el provider verifique positivamente la identidad del contribuyente
}
