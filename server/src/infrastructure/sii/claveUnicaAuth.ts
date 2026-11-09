import { AppError } from '../../domain/errors.js';
import { AuthAttemptGuard } from './authAttemptGuard.js';
import {
  boundedHumanDelay,
  evaluateDomAuthState,
  extractSafeOriginAndPath,
  parseExactOrigin,
  SiiPageLike,
} from './siiPage.js';

export interface ClaveUnicaReturnDiagnostic {
  formularioSigue: boolean;
  origen: string | null;
  ruta: string | null;
  codigo: string;
}

export interface ClaveUnicaAuthParams {
  page: SiiPageLike;
  rut: string;
  password: string;
  guard: AuthAttemptGuard;
  signal?: AbortSignal;
  onReturnDiagnostic?: (diagnostic: ClaveUnicaReturnDiagnostic) => void;
}

export interface ClaveUnicaAuthResult {
  formOrigin: string;
  diagnosticoRetorno?: ClaveUnicaReturnDiagnostic;
}

const CLAVE_UNICA_ALLOWED_ORIGIN = 'https://accounts.claveunica.gob.cl';
const ZEUSR_ALLOWED_ORIGIN = 'https://zeusr.sii.cl';

/**
 * Normaliza el RUT para ingreso en el portal de Clave Única en formato RUN estándar chileno con puntos y guion (ej. 12.345.678-K).
 * El portal oficial de Clave Única (rut-helper.js / oidc.js) aplica máscara y validación de cliente sobre este formato.
 */
export function formatRutForClaveUnica(rawRut: string): string {
  const cleaned = rawRut.trim().replaceAll('.', '').replaceAll('-', '').toUpperCase();
  if (cleaned.length < 2) {
    return rawRut.trim().toUpperCase();
  }
  const body = cleaned.slice(0, -1);
  const dv = cleaned.slice(-1);
  const formattedBody = body.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${formattedBody}-${dv}`;
}

/**
 * Inspecciona el formulario de Clave Única en el DOM.
 * Ejecutada en el navegador como JS puro serializable.
 */
export function evaluateClaveUnicaFormMeta() {
  const form = document.querySelector('form#login-form');
  if (!form) {
    return { exists: false, actionUrl: '', method: '' };
  }
  return {
    exists: true,
    actionUrl: form.action || '',
    method: (form.method || '').toLowerCase(),
  };
}

/**
 * Inspecciona los campos del formulario de Clave Única en el DOM.
 * Ejecutada en el navegador como JS puro serializable.
 */
export function evaluateClaveUnicaFormFields() {
  const runEl = document.querySelector('form#login-form #uname, form#login-form input#uname');
  const passEl = document.querySelector('form#login-form #pword, form#login-form input#pword');
  const btnEl = document.querySelector('form#login-form #login-submit, form#login-form button#login-submit');

  return {
    hasRun: Boolean(runEl),
    hasPass: Boolean(passEl),
    hasBtn: Boolean(btnEl),
  };
}

/**
 * Valida eventos y estado de controles de Clave Única en el DOM.
 * Ejecutada en el navegador como JS puro serializable.
 */
export function evaluateClaveUnicaFormValidation() {
  const form = document.querySelector('form#login-form');
  const uname = document.querySelector('form#login-form #uname, form#login-form input#uname');
  const pword = document.querySelector('form#login-form #pword, form#login-form input#pword');
  const btn = document.querySelector('form#login-form #login-submit, form#login-form button#login-submit');

  if (uname) {
    uname.dispatchEvent?.(new Event('input', { bubbles: true }));
    uname.dispatchEvent?.(new Event('change', { bubbles: true }));
    uname.dispatchEvent?.(new KeyboardEvent('keyup', { bubbles: true, key: 'Tab' }));
    uname.dispatchEvent?.(new Event('blur', { bubbles: true }));
  }
  if (pword) {
    pword.dispatchEvent?.(new Event('input', { bubbles: true }));
    pword.dispatchEvent?.(new Event('change', { bubbles: true }));
    pword.dispatchEvent?.(new KeyboardEvent('keyup', { bubbles: true, key: 'Tab' }));
    pword.dispatchEvent?.(new Event('blur', { bubbles: true }));
  }

  const unameGroup = uname?.closest?.('.group-label');
  const pwordGroup = pword?.closest?.('.group-label');
  const hasUnameError = unameGroup?.classList?.contains('control-error') ?? false;
  const hasPwordError = pwordGroup?.classList?.contains('control-error') ?? false;

  const isUnameValid = typeof uname?.checkValidity === 'function' ? uname.checkValidity() : true;
  const isPwordValid = typeof pword?.checkValidity === 'function' ? pword.checkValidity() : true;
  const isFormValid = typeof form?.checkValidity === 'function' ? form.checkValidity() : true;

  const hasDisabledAttr = typeof btn?.getAttribute === 'function' ? btn.getAttribute('disabled') !== null : false;
  const isBtnDisabled = btn
    ? Boolean(btn.disabled || btn.classList?.contains('disabled_butt') || hasDisabledAttr)
    : true;

  return {
    hasClientError: hasUnameError || hasPwordError,
    btnDisabled: isBtnDisabled,
    isValid: isUnameValid && isPwordValid && isFormValid,
  };
}

/**
 * Inspecciona el estado posterior al submit de Clave Única en el DOM.
 * Ejecutada en el navegador como JS puro serializable.
 */
export function evaluateClaveUnicaPostSubmitState() {
  const form = document.querySelector('form#login-form');
  const uname = document.querySelector('#uname, input#uname');
  const submit = document.querySelector('#login-submit, button#login-submit');
  const formRemains = Boolean(form || (uname && submit));

  const body = document.body;
  const text = body ? (body.innerText || '') : '';

  // Detección de mensajes o clases de error locales en Clave Única
  const hasControlError = Boolean(
    document.querySelector('form#login-form .control-error, form#login-form .is-invalid')
  );
  const localErrorEl = document.querySelector('#local_error_message, #local_error_text');
  const localErrorText = localErrorEl ? (localErrorEl.textContent || '').trim() : '';
  const combinedText = localErrorText ? `${text} ${localErrorText}` : text;

  const captchaElements = document.querySelectorAll(
    'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], div.g-recaptcha, div.h-captcha, input#captcha, img[src*="captcha"]'
  );
  let hasVisibleCaptcha = false;
  for (const el of Array.from(captchaElements)) {
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
    const style = window.getComputedStyle(el);
    if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
      hasVisibleCaptcha = true;
      break;
    }
  }

  const mfaInputs = document.querySelectorAll(
    'input[name*="otp" i], input[id*="otp" i], input[name*="code" i], input[id*="code" i], input[autocomplete="one-time-code"]'
  );
  let hasMfaOrChallenge = false;
  for (const el of Array.from(mfaInputs)) {
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
    const style = window.getComputedStyle(el);
    if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
      hasMfaOrChallenge = true;
      break;
    }
  }

  return {
    formRemains,
    bodyText: combinedText,
    hasVisibleCaptcha,
    hasMfaOrChallenge,
    hasControlError,
  };
}

/**
 * Valida de forma estricta que la página pertenezca a accounts.claveunica.gob.cl
 * y que el formulario apunte al mismo origen seguro con método POST y path oficial.
 * No registra URLs completas ni tokens de consulta en los mensajes de error.
 */
export async function assertClaveUnicaFormSecurity(
  page: SiiPageLike,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
  }

  const currentUrl = await page.url();
  const parsedPageUrl = parseExactOrigin(currentUrl);

  if (parsedPageUrl?.origin !== CLAVE_UNICA_ALLOWED_ORIGIN) {
    throw new AppError(
      'SECURITY_VIOLATION',
      'El portal de Clave Única no se encuentra en el origen seguro permitido.',
      502
    );
  }

  // Esperar a que el selector oficial form#login-form esté disponible en el DOM
  if (page.waitForSelector) {
    await page.waitForSelector('form#login-form', { timeout: 15000 }).catch(() => {});
  }

  let formMeta = await page.evaluate<{ exists: boolean; actionUrl: string; method: string }>(
    evaluateClaveUnicaFormMeta
  );

  // Si no está disponible aún (transición asíncrona del DOM), reintentar brevemente de forma acotada
  if (!formMeta.exists) {
    const deadline = Date.now() + 5000;
    while (!formMeta.exists && Date.now() < deadline) {
      if (signal?.aborted) {
        throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
      }
      await boundedHumanDelay(200, 300, signal).catch(() => {});
      try {
        formMeta = await page.evaluate<{ exists: boolean; actionUrl: string; method: string }>(
          evaluateClaveUnicaFormMeta
        );
      } catch {
        // En caso de cambio o transición momentánea de contexto
      }
    }
  }

  if (!formMeta.exists) {
    throw new AppError(
      'FORM_NOT_FOUND',
      'No se encontró el formulario oficial de autenticación de Clave Única (form#login-form).',
      502
    );
  }

  if (formMeta.method !== 'post') {
    throw new AppError(
      'SECURITY_VIOLATION',
      'El método del formulario de Clave Única no es POST seguro.',
      502
    );
  }

  const parsedActionUrl = parseExactOrigin(formMeta.actionUrl);
  const isValidActionPath =
    parsedActionUrl?.pathname === '/accounts/login' ||
    parsedActionUrl?.pathname === '/accounts/login/';

  if (parsedActionUrl?.origin !== CLAVE_UNICA_ALLOWED_ORIGIN || !isValidActionPath) {
    throw new AppError(
      'SECURITY_VIOLATION',
      'La acción del formulario no apunta al destino oficial seguro permitido.',
      502
    );
  }
}

/**
 * authenticateClaveUnica
 * Ejecuta el flujo estricto de autenticación con Clave Única:
 * 1. Desde la página de autenticación de SII (zeusr.sii.cl), pulsar enlace de Clave Única (a#myHref).
 * 2. Esperar navegación al portal oficial https://accounts.claveunica.gob.cl/accounts/login/?next=...
 * 3. Validar origen seguro de la página y formulario antes de introducir credenciales.
 * 4. Rellenar RUN y Clave con re-validación de origen y señal antes de cada acción.
 * 5. Reservar intento en el guard INMEDIATAMENTE antes del click del botón de ingreso y comprobación de señal.
 * 6. Esperar redirección de retorno al SII y sondear resultado.
 */
export async function authenticateClaveUnica(
  params: ClaveUnicaAuthParams
): Promise<ClaveUnicaAuthResult> {
  const { page, rut, password, guard, signal } = params;

  if (signal?.aborted) {
    throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
  }

  // 1. Si estamos en zeusr.sii.cl, pulsar el enlace a Clave Única (#myHref)
  const currentUrl = await page.url();
  const parsedCurrentUrl = parseExactOrigin(currentUrl);

  if (parsedCurrentUrl?.origin === ZEUSR_ALLOWED_ORIGIN) {
    const claveUnicaLink = page.locator('#myHref');
    await claveUnicaLink.click();
    await boundedHumanDelay(500, 1000, signal);
  } else if (parsedCurrentUrl?.origin !== CLAVE_UNICA_ALLOWED_ORIGIN) {
    throw new AppError(
      'SECURITY_VIOLATION',
      'El portal no se encuentra en el origen seguro permitido.',
      502
    );
  }

  // Esperar a que la URL sea exactamente de Clave Única (hasta 15s con temporizador abortable)
  const waitLimit = Date.now() + 15000;
  while (Date.now() < waitLimit) {
    if (signal?.aborted) {
      throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
    }
    const checkUrl = await page.url();
    const parsedCheck = parseExactOrigin(checkUrl);
    if (parsedCheck?.origin === CLAVE_UNICA_ALLOWED_ORIGIN) {
      break;
    }
    if (parsedCheck?.origin !== ZEUSR_ALLOWED_ORIGIN) {
      throw new AppError(
        'SECURITY_VIOLATION',
        'El portal no se encuentra en el origen seguro permitido.',
        502
      );
    }
    await boundedHumanDelay(300, 300, signal);
  }

  // Esperar a que el selector oficial form#login-form esté disponible en el DOM
  if (page.waitForSelector) {
    await page.waitForSelector('form#login-form', { timeout: 15000 }).catch(() => {});
  }

  // 2. Validar seguridad del formulario de Clave Única antes de interactuar
  await assertClaveUnicaFormSecurity(page, signal);

  await boundedHumanDelay(250, 450, signal);

  // 3. Identificar campos exactos observados públicamente en Clave Única:
  // #uname (con name="run"), #pword (type="password") y #login-submit
  const formFields = await page.evaluate<{
    hasRun: boolean;
    hasPass: boolean;
    hasBtn: boolean;
  }>(evaluateClaveUnicaFormFields);

  if (!formFields.hasRun || !formFields.hasPass || !formFields.hasBtn) {
    throw new AppError(
      'FORM_INCOMPLETE',
      'No fue posible ubicar los campos necesarios en el portal de Clave Única (#uname, #pword, #login-submit).',
      502
    );
  }

  // Re-validar origen y señal antes de rellenar RUN (#uname)
  if (signal?.aborted) {
    throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
  }
  await assertClaveUnicaFormSecurity(page);

  const runInput = page.locator('#uname');
  const formattedRut = formatRutForClaveUnica(rut);
  await runInput.fill(formattedRut);

  await boundedHumanDelay(250, 450, signal);

  // Re-validar origen y señal antes de rellenar password (#pword)
  if (signal?.aborted) {
    throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
  }
  await assertClaveUnicaFormSecurity(page);

  const passInput = page.locator('#pword');
  await passInput.fill(password);

  await boundedHumanDelay(250, 450, signal);

  // Sincronizar eventos estándar de entrada y teclado sin Enter (input, change, keyup neutro con Tab, blur)
  // para permitir que los manejadores de cliente procesen la entrada sin forzar controles ni provocar submits involuntarios
  const formValidation = await page.evaluate<{
    hasClientError: boolean;
    btnDisabled: boolean;
    isValid: boolean;
  }>(evaluateClaveUnicaFormValidation);

  if (formValidation?.hasClientError) {
    throw new AppError(
      'INVALID_CREDENTIALS',
      'El RUN o la clave ingresada no son válidos según la validación previa del portal.',
      401
    );
  }

  if (formValidation?.btnDisabled || formValidation?.isValid === false) {
    throw new AppError(
      'FORM_NOT_READY',
      'El formulario de autenticación de Clave Única no se encuentra listo para el envío (botón deshabilitado o validación no superada).',
      502
    );
  }

  // Re-validar seguridad justo antes de enviar
  if (signal?.aborted) {
    throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
  }
  await assertClaveUnicaFormSecurity(page);

  // 4. Reservar intento en el guard INMEDIATAMENTE antes del click
  await guard.reserveAttempt(15);

  // Comprobar aborto inmediatamente después de la reserva antes de accionar el click
  if (signal?.aborted) {
    throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
  }

  // 5. Click único en el botón de ingreso (#login-submit) - sin bucles ni reintentos
  const submitButton = page.locator('#login-submit');
  await submitButton.click();

  // 6. Esperar y sondear resultado con diagnóstico seguro de retorno
  const { onReturnDiagnostic } = params;
  const startTime = Date.now();
  const pollIntervalMs = 500;
  const timeoutMs = 40000;

  let lastDiagnostic: ClaveUnicaReturnDiagnostic = {
    formularioSigue: true,
    origen: CLAVE_UNICA_ALLOWED_ORIGIN,
    ruta: '/accounts/login',
    codigo: 'PENDING',
  };

  while (Date.now() - startTime < timeoutMs) {
    if (signal?.aborted) {
      throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
    }

    let currentUrl = '';
    try {
      currentUrl = await page.url();
    } catch {
      if (signal?.aborted) {
        throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
      }
      await boundedHumanDelay(pollIntervalMs, pollIntervalMs, signal);
      continue;
    }

    const safeUrl = extractSafeOriginAndPath(currentUrl);
    const parsedOrigin = parseExactOrigin(currentUrl);

    // Si ha retornado/redirigido a un dominio del SII
    const isSiiDomain =
      parsedOrigin &&
      (parsedOrigin.hostname === 'sii.cl' || parsedOrigin.hostname.endsWith('.sii.cl'));

    if (isSiiDomain) {
      const isPortal = parsedOrigin.pathname.includes('/consdcvinternetui');
      lastDiagnostic = {
        formularioSigue: false,
        origen: safeUrl.origin,
        ruta: safeUrl.path,
        codigo: isPortal ? 'RCV_PORTAL' : 'RETURNED_TO_SII',
      };
      onReturnDiagnostic?.(lastDiagnostic);
      return {
        formOrigin: CLAVE_UNICA_ALLOWED_ORIGIN,
        diagnosticoRetorno: lastDiagnostic,
      };
    }

    let formStillExists = false;
    let evalData: {
      bodyText: string;
      hasVisibleCaptcha: boolean;
      hasMfaOrChallenge: boolean;
      hasControlError?: boolean;
    } = {
      bodyText: '',
      hasVisibleCaptcha: false,
      hasMfaOrChallenge: false,
      hasControlError: false,
    };

    try {
      const inspected = await page.evaluate<{
        formRemains: boolean;
        bodyText: string;
        hasVisibleCaptcha: boolean;
        hasMfaOrChallenge: boolean;
        hasControlError: boolean;
      }>(evaluateClaveUnicaPostSubmitState);

      formStillExists = inspected.formRemains;
      evalData = inspected;
    } catch {
      if (signal?.aborted) {
        throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
      }
      await boundedHumanDelay(pollIntervalMs, pollIntervalMs, signal);
      continue;
    }

    const domAuth = evaluateDomAuthState({
      url: currentUrl,
      bodyText: evalData.bodyText,
      hasVisibleCaptcha: evalData.hasVisibleCaptcha,
      hasMfaOrChallenge: evalData.hasMfaOrChallenge,
    });

    if (domAuth.state === 'account_blocked') {
      lastDiagnostic = {
        formularioSigue: formStillExists,
        origen: safeUrl.origin,
        ruta: safeUrl.path,
        codigo: 'ACCOUNT_BLOCKED',
      };
      onReturnDiagnostic?.(lastDiagnostic);
      guard.markBlocked(Math.max(domAuth.retryAfterSeconds || 1800, 1800));
      throw new AppError(
        'ACCOUNT_BLOCKED',
        domAuth.message || 'La cuenta o portal se encuentra temporalmente bloqueado.',
        429,
        Math.max(domAuth.retryAfterSeconds || 1800, 1800)
      );
    }

    if (domAuth.state === 'challenge_required') {
      lastDiagnostic = {
        formularioSigue: formStillExists,
        origen: safeUrl.origin,
        ruta: safeUrl.path,
        codigo: 'CHALLENGE_REQUIRED',
      };
      onReturnDiagnostic?.(lastDiagnostic);
      throw new AppError(
        'CHALLENGE_REQUIRED',
        domAuth.message || 'Se requiere completar un desafío de seguridad interactivo en el portal.',
        403
      );
    }

    if (domAuth.state === 'invalid_credentials' || (formStillExists && evalData.hasControlError)) {
      lastDiagnostic = {
        formularioSigue: formStillExists,
        origen: safeUrl.origin,
        ruta: safeUrl.path,
        codigo: 'INVALID_CREDENTIALS',
      };
      onReturnDiagnostic?.(lastDiagnostic);
      throw new AppError(
        'INVALID_CREDENTIALS',
        domAuth.message || 'Las credenciales de Clave Única ingresadas son incorrectas.',
        401
      );
    }

    lastDiagnostic = {
      formularioSigue: formStillExists,
      origen: safeUrl.origin,
      ruta: safeUrl.path,
      codigo: formStillExists ? 'FORM_STILL_PRESENT' : 'PENDING',
    };

    await boundedHumanDelay(pollIntervalMs, pollIntervalMs, signal);
  }

  onReturnDiagnostic?.(lastDiagnostic);
  throw new AppError(
    'SESSION_UNVERIFIED',
    'Tiempo de espera de autenticación agotado sin confirmación de sesión.',
    401
  );
}
