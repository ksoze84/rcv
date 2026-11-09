import { AppError } from '../../domain/errors.js';

declare global {
  interface MinimalDomOption {
    text?: string;
    value?: string;
    selected?: boolean;
    textContent?: string | null;
  }

  interface MinimalDomElement {
    id?: string;
    className?: string;
    name?: string;
    value?: string;
    selectedIndex?: number;
    action?: string;
    method?: string;
    textContent?: string | null;
    innerText?: string | null;
    options?: ArrayLike<MinimalDomOption>;
    selectedOptions?: ArrayLike<MinimalDomOption>;
    disabled?: boolean;
    dataset?: Record<string, string | undefined>;
    classList?: {
      contains(token: string): boolean;
      remove(token: string): void;
      add(token: string): void;
    };
    hidden?: boolean;
    href?: string;
    style?: { display?: string; visibility?: string };
    checkValidity?(): boolean;
    getAttribute?(qualifiedName: string): string | null;
    removeAttribute?(qualifiedName: string): void;
    getBoundingClientRect?(): { width: number; height: number };
    click?(): void;
    remove?(): void;
    removeChild?(child: unknown): void;
    parentNode?: MinimalDomElement | null;
    parentElement?: MinimalDomElement | null;
    dispatchEvent?(event: unknown): boolean;
    matches?(selector: string): boolean;
    closest?(selector: string): MinimalDomElement | null;
    querySelector?(selector: string): MinimalDomElement | null;
    querySelectorAll?(selector: string): ArrayLike<MinimalDomElement>;
    ownerDocument?: {
      defaultView?: MinimalWindow | null;
    } | null;
  }

  interface MinimalDocument {
    body?: (MinimalDomElement & { innerText?: string }) | null;
    querySelector(selector: string): MinimalDomElement | null;
    querySelectorAll(selector: string): ArrayLike<MinimalDomElement>;
  }

  interface MinimalWindow {
    location?: { hash?: string; href?: string; origin?: string };
    getComputedStyle(element: unknown): { display: string; visibility: string };
    angular?: {
      element?: (el: unknown) => {
        triggerHandler?: (evt: string) => void;
        controller?: (name: string) => {
          $setViewValue?: (v: unknown) => void;
          $render?: () => void;
        };
        scope?: () => {
          $apply?: (fn?: () => void) => void;
          $$phase?: string;
        };
      };
    };
    jQuery?: ((el: unknown) => { triggerHandler?: (evt: string) => void }) & {
      (el: unknown): { triggerHandler?: (evt: string) => void };
    };
    $?: ((el: unknown) => { triggerHandler?: (evt: string) => void }) & {
      (el: unknown): { triggerHandler?: (evt: string) => void };
    };
    Event?: { new (type: string, dict?: unknown): unknown };
    dispatchEvent?(event: unknown): boolean;
  }

  const document: MinimalDocument;
  const window: MinimalWindow;
  const KeyboardEvent: { new (type: string, eventInitDict?: unknown): unknown };
}

export interface SiiLocatorLike {
  fill(value: string): Promise<unknown>;
  click(options?: unknown): Promise<unknown>;
  selectOption(values: string | string[]): Promise<string[] | void>;
  first(): SiiLocatorLike;
  nth(index: number): SiiLocatorLike;
}

export interface SiiPageLike {
  url(): string | Promise<string>;
  evaluate<R, A = unknown>(pageFunction: string | ((arg: A) => R), arg?: A): Promise<R>;
  locator(selector: string): SiiLocatorLike;
  waitForSelector?(selector: string, options?: { timeout?: number }): Promise<unknown>;
}

export interface AuthPollResult {
  state: 'pending' | 'redirected' | 'invalid_credentials' | 'account_blocked' | 'challenge_required';
  message?: string;
  retryAfterSeconds?: number;
}

/**
 * Genera una pausa pseudo-aleatoria acotada entre minMs y maxMs para simular
 * cadencia humana entre interacciones en el navegador.
 * Soporta cancelación inmediata mediante AbortSignal.
 */
export async function boundedHumanDelay(
  minMs = 250,
  maxMs = 650,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
  }
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(signal?.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499));
    };

    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Verifica si una URL tiene esquema exacto https: y origen en dominios oficiales del SII o Clave Única.
 * Rechaza credenciales incrustadas (username/password en URL).
 */
export function parseExactOrigin(urlString: string): URL | null {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Extrae de forma segura el origen y la ruta de una URL, eliminando estrictamente
 * cadenas de consulta (?query), credenciales y fragmentos (#hash).
 */
export function extractSafeOriginAndPath(urlString: string): { origin: string | null; path: string | null } {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { origin: null, path: null };
    }
    return {
      origin: parsed.origin,
      path: parsed.pathname,
    };
  } catch {
    return { origin: null, path: null };
  }
}

/**
 * Sanitiza una cadena eliminando espacios redundantes y caracteres de control
 * para inspección segura de textos en el DOM sin registrar secretos.
 */
export function sanitizeDomText(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Clasifica de forma determinista el estado de autenticación según el DOM de la página.
 * NO vuelca el HTML completo a logs.
 * Nunca retorna mensajes dinámicos con URLs completas o parámetros de consulta.
 * El estado por defecto cuando no hay error específico ni redirección protegida es 'pending'.
 */
export function evaluateDomAuthState(htmlSnapshot: {
  url: string;
  bodyText: string;
  hasVisibleCaptcha: boolean;
  hasMfaOrChallenge?: boolean;
}): AuthPollResult {
  const { url, bodyText, hasVisibleCaptcha, hasMfaOrChallenge } = htmlSnapshot;
  const lowerText = bodyText.toLowerCase();

  // 1. Bloqueo de cuenta explícito y acotado (no textos informativos genéricos sobre bloqueo de tarjeta/clave)
  const isExplicitBlocked =
    lowerText.includes('cuenta bloqueada') ||
    lowerText.includes('cuenta ha sido bloqueada') ||
    lowerText.includes('acceso bloqueado') ||
    lowerText.includes('clave bloqueada') ||
    lowerText.includes('claveúnica bloqueada') ||
    lowerText.includes('claveunica bloqueada') ||
    lowerText.includes('ha superado el número máximo de intentos') ||
    lowerText.includes('superado el maximo de intentos permitidos') ||
    lowerText.includes('superado el número máximo de intentos') ||
    lowerText.includes('demasiados intentos de inicio de sesión') ||
    lowerText.includes('bloqueada por demasiados intentos');

  if (isExplicitBlocked) {
    return {
      state: 'account_blocked',
      message: 'La cuenta ha sido bloqueada por exceder el número máximo de intentos permitidos.',
      retryAfterSeconds: 1800,
    };
  }

  // 2. Desafío interactivo visible explícito (CAPTCHA, MFA, OTP, segundo factor)
  if (hasVisibleCaptcha || hasMfaOrChallenge) {
    return {
      state: 'challenge_required',
      message: 'Se requiere completar un desafío interactivo de seguridad o segundo factor.',
    };
  }

  // 3. Credenciales inválidas explícitas basadas únicamente en mensajes de error
  const isExplicitBadCredentials =
    lowerText.includes('clave tributaria ingresada no es correcta') ||
    lowerText.includes('clave o rut incorrecto') ||
    lowerText.includes('rut o clave incorrecta') ||
    lowerText.includes('rut o contraseña incorrecta') ||
    lowerText.includes('el rut o la clave ingresada no es correcta') ||
    lowerText.includes('dígito verificador incorrecto') ||
    lowerText.includes('clave única incorrecta') ||
    lowerText.includes('claveunica incorrecta') ||
    lowerText.includes('los datos ingresados son incorrectos') ||
    lowerText.includes('no coinciden con nuestros registros') ||
    lowerText.includes('el run o clave que ingresaste no son correctos') ||
    lowerText.includes('el run o la clave ingresada no son correctos') ||
    lowerText.includes('el run o la clave que ingresaste no son correctos') ||
    lowerText.includes('run o clave incorrecta') ||
    lowerText.includes('run o clave incorrecto') ||
    lowerText.includes('clave incorrecta') ||
    lowerText.includes('rut incorrecto');

  if (isExplicitBadCredentials) {
    return {
      state: 'invalid_credentials',
      message: 'El RUT o la clave ingresada no son válidos.',
    };
  }

  // 4. Redirección a portal protegido reconocido (ej. consdcvinternetui)
  const parsedUrl = parseExactOrigin(url);
  if (parsedUrl) {
    const isSiiDomain =
      parsedUrl.hostname === 'sii.cl' ||
      parsedUrl.hostname.endsWith('.sii.cl');

    if (isSiiDomain && parsedUrl.pathname.includes('/consdcvinternetui')) {
      return {
        state: 'redirected',
      };
    }
  }

  // Si no hay errores evidentes ni redirección a portal protegido, el estado sigue pendiente
  return {
    state: 'pending',
  };
}

/**
 * Inspecciona el DOM en el navegador para evaluar texto y presencia de desafíos visibles/MFA.
 * Ejecutada directamente dentro del contexto del navegador (JS puro serializable).
 */
export function evaluateAuthPollingSnapshot() {
  const body = document.body;
  const text = body ? (body.innerText || '') : '';

  // Detección estricta de desafíos visibles: no contar scripts ocultos
  const captchaElements = document.querySelectorAll(
    'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], div.g-recaptcha, div.h-captcha, input#captcha, img[src*="captcha"]'
  );
  let hasVisibleCaptcha = false;
  for (const el of Array.from(captchaElements)) {
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
    const style = window.getComputedStyle(el);
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden'
    ) {
      hasVisibleCaptcha = true;
      break;
    }
  }

  // Detección de MFA o inputs interactivos de segundo factor
  const mfaInputs = document.querySelectorAll(
    'input[name*="otp" i], input[id*="otp" i], input[name*="code" i], input[id*="code" i], input[autocomplete="one-time-code"]'
  );
  let hasMfaOrChallenge = false;
  for (const el of Array.from(mfaInputs)) {
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
    const style = window.getComputedStyle(el);
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden'
    ) {
      hasMfaOrChallenge = true;
      break;
    }
  }

  return {
    bodyText: text,
    hasVisibleCaptcha,
    hasMfaOrChallenge,
  };
}

/**
 * Espera y sondea de forma segura el resultado de la autenticación en el navegador
 * hasta por un máximo de timeoutMs (40s por defecto).
 */
export async function pollAuthenticationResult(
  page: SiiPageLike,
  signal?: AbortSignal,
  timeoutMs = 40000,
  pollIntervalMs = 500
): Promise<AuthPollResult> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (signal?.aborted) {
      throw signal.reason || new AppError('OPERATION_ABORTED', 'Autenticación cancelada.', 499);
    }

    let currentUrl = '';
    try {
      currentUrl = await page.url();
    } catch {
      if (signal?.aborted) {
        throw signal.reason || new AppError('OPERATION_ABORTED', 'Autenticación cancelada.', 499);
      }
      // Error transitorio durante navegación de ciclo de vida
      await boundedHumanDelay(pollIntervalMs, pollIntervalMs, signal);
      continue;
    }

    let snapshot: { bodyText: string; hasVisibleCaptcha: boolean; hasMfaOrChallenge: boolean };
    try {
      snapshot = await page.evaluate<{
        bodyText: string;
        hasVisibleCaptcha: boolean;
        hasMfaOrChallenge: boolean;
      }>(evaluateAuthPollingSnapshot);
    } catch {
      if (signal?.aborted) {
        throw signal.reason || new AppError('OPERATION_ABORTED', 'Autenticación cancelada.', 499);
      }
      // Si la página está transitando o evaluando en un contexto desmontado
      await boundedHumanDelay(pollIntervalMs, pollIntervalMs, signal);
      continue;
    }

    const evaluated = evaluateDomAuthState({
      url: currentUrl,
      bodyText: snapshot.bodyText,
      hasVisibleCaptcha: snapshot.hasVisibleCaptcha,
      hasMfaOrChallenge: snapshot.hasMfaOrChallenge,
    });

    if (
      evaluated.state === 'account_blocked' ||
      evaluated.state === 'challenge_required' ||
      evaluated.state === 'invalid_credentials' ||
      evaluated.state === 'redirected'
    ) {
      return evaluated;
    }

    // evaluated.state === 'pending' -> esperar siguiente iteración de sondeo
    await boundedHumanDelay(pollIntervalMs, pollIntervalMs, signal);
  }

  throw new AppError(
    'SESSION_UNVERIFIED',
    'Tiempo de espera de autenticación agotado sin confirmación de sesión.',
    401
  );
}
