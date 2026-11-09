import { AppError, isAppError } from '../../domain/errors.js';
import { isValidRut, normalizeRut, RcvTabDiagnostic } from '../../../../shared/rcv.js';
import { boundedHumanDelay, SiiPageLike } from './siiPage.js';

export interface IdentityVerificationResult {
  verified: boolean;
  contributorRut?: string;
  contributorName?: string;
}

export interface PeriodSelectionOptions {
  year: number;
  month: number;
}

export type RcvTabType = 'Compras' | 'Ventas';

export interface TabInspectionResult {
  hasNoMovements: boolean;
  canDownload: boolean;
  periodConfirmed?: boolean;
  activeTabConfirmed?: boolean;
  tabDiagnostic?: RcvTabDiagnostic;
}

export interface EvaluateInspectResult {
  hasNoMovements: boolean;
  hasDownloadButton: boolean;
  periodConfirmed: boolean;
  activeTabConfirmed: boolean;
  subtabRegistroFound: boolean;
  subtabRegistroActive: boolean;
  downloadButtonsFound: number;
  detalleButtonFound: boolean;
  detalleButtonVisible: boolean;
  tableCount: number;
  noMovementsPatternFound: boolean;
  hashEndsWith: string;
  downloadButtonLabels?: string[];
  detalleRejectedByOppositeContainer?: boolean;
  detalleRejectedByVisibility?: boolean;
  detalleRejectedBySubtabFilter?: boolean;
}

export interface SelectPeriodOptions {
  clickConsultar?: boolean;
  requireAngular?: boolean;
}

export interface RcvDomResultsStatus {
  hasConsultarButton: boolean;
  hasTabs: boolean;
  comprasTabFound: boolean;
  ventasTabFound: boolean;
  tableCount: number;
  hasNoMovementsMessage: boolean;
  noMovementsText?: string | undefined;
  hasErrorMessage: boolean;
  errorMessage?: string | undefined;
  periodConfirmed: boolean;
}

export interface RcvContextState {
  currentUrl: string;
  activeRut?: string;
  selectedYear?: number;
  selectedMonth?: number;
  activeTab?: RcvTabType;
}

/**
 * Valida que la URL actual pertenezca estrictamente al portal de RCV oficial.
 * Exige esquema HTTPS exacto, sin credenciales incrustadas, host www4.sii.cl
 * y ruta correspondiente al módulo consdcvinternetui.
 */
export function isExactRcvPortalUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      return false;
    }
    return (
      parsed.origin === 'https://www4.sii.cl' &&
      (parsed.pathname === '/consdcvinternetui' || parsed.pathname.startsWith('/consdcvinternetui/'))
    );
  } catch {
    return false;
  }
}

/**
 * Maneja de forma segura las excepciones ocurridas durante la interacción con la página,
 * preservando códigos de error legítimos (PERIOD_SELECT_FAILED, ANGULAR_NOT_AVAILABLE, etc.)
 * y clasificando errores transitorios o de ejecución sin interpolar datos sensibles ni
 * convertir fallos legítimos en EVALUATE_FAILED genéricos.
 */
export function handleNavigationError(err: unknown, defaultStage: string): never {
  if (err instanceof AppError) {
    throw err;
  }
  if (isAppError(err)) {
    throw new AppError(
      err.code,
      err.message || 'Error en portal RCV.',
      err.httpStatus,
      err.retryAfterSeconds,
      { stage: err.stage || defaultStage, ...(err.details || {}) }
    );
  }
  const errName = typeof (err as { name?: string })?.name === 'string' ? (err as { name?: string }).name! : '';
  const rawMsg = typeof (err as { message?: string })?.message === 'string' ? (err as { message?: string }).message! : '';
  const errCode = typeof (err as { code?: string })?.code === 'string' ? (err as { code?: string }).code! : '';

  // 1. Preservar errores que ya tienen un código de dominio legítimo (AppError duck-typing o similar)
  if (errCode && errCode !== 'EVALUATE_FAILED') {
    throw new AppError(
      errCode,
      rawMsg || 'Error durante la interacción con el portal de RCV.',
      typeof (err as { httpStatus?: number })?.httpStatus === 'number' ? (err as { httpStatus: number }).httpStatus : 502,
      undefined,
      { stage: (err as { stage?: string })?.stage || defaultStage }
    );
  }

  // 2. Cancelaciones / AbortError
  if (
    errName === 'AbortError' ||
    rawMsg.toLowerCase().includes('aborted') ||
    rawMsg.toLowerCase().includes('operación cancelada')
  ) {
    throw new AppError(
      'OPERATION_ABORTED',
      'Operación cancelada.',
      499,
      undefined,
      { stage: defaultStage }
    );
  }

  // 3. Timeouts
  const isTimeout =
    errName === 'TimeoutError' ||
    errName.includes('Timeout') ||
    errCode === 'ETIMEDOUT' ||
    rawMsg.includes('Timeout') ||
    rawMsg.includes('timed out') ||
    rawMsg.includes('operation timed out');

  if (isTimeout) {
    throw new AppError(
      'TIMEOUT',
      'Tiempo de espera agotado durante la interacción con el portal de RCV.',
      504,
      undefined,
      { stage: defaultStage }
    );
  }

  // 4. Códigos de error legítimos contenidos explícitamente en el mensaje para no enmascarar
  const upperMsg = rawMsg.toUpperCase();
  const knownCodes = [
    'PERIOD_SELECT_FAILED',
    'ANGULAR_NOT_AVAILABLE',
    'QUERY_BUTTON_MISSING',
    'RESULTS_NOT_RENDERED',
    'TAB_NOT_FOUND',
    'TAB_ACTIVATION_FAILED',
    'DOWNLOAD_TRIGGER_FAILED',
    'DOWNLOAD_CONFIRM_REQUIRED',
    'RCV_DOWNLOAD_UNAVAILABLE',
    'OPERATION_ABORTED',
  ];
  for (const code of knownCodes) {
    if (upperMsg.includes(code)) {
      throw new AppError(
        code,
        `Fallo clasificado en etapa ${defaultStage}: ${code}`,
        502,
        undefined,
        { stage: defaultStage }
      );
    }
  }

  // 5. Fallo general en evaluación / interacción en la página
  throw new AppError(
    'EVALUATE_FAILED',
    'Fallo durante la evaluación o interacción en la página del RCV.',
    502,
    undefined,
    { stage: defaultStage }
  );
}

export interface ContributorEvalDom {
  hasRcvControls?: boolean;
  selectOptionRuts?: string[];
  selectHasOptions?: boolean;
  selectedOptionTexts?: string[];
  selectedOptionValues?: string[];
  headerRuts?: string[];
  headerText?: string;
  isPublicOrLoginPage?: boolean;
}

/**
 * Evalúa los elementos DOM relevantes en el portal RCV para verificar la identidad activa.
 */
export function queryContributorDom(): ContributorEvalDom {
  const selects = Array.from(document.querySelectorAll('select'));
  const hasRcvRoot = Boolean(
    document.querySelector(
      '#consdcv, #rcvApp, #app, [ng-app], [ui-view], .consdcv, #main-content, #wrapper, [ng-controller]'
    )
  );

  const hasRutSelect = selects.some((sel) => {
    const name = sel.name || sel.getAttribute?.('name') || '';
    const id = sel.id || sel.getAttribute?.('id') || '';
    const ngModel = sel.getAttribute?.('ng-model') || sel.dataset?.ngModel || '';
    return /rut|contribuyente/i.test(name) || /rut|contribuyente/i.test(id) || /rut|contribuyente/i.test(ngModel);
  });

  const hasMesSelect = selects.some((sel) => {
    const name = sel.name || sel.getAttribute?.('name') || '';
    const id = sel.id || sel.getAttribute?.('id') || '';
    const ngModel = sel.getAttribute?.('ng-model') || sel.dataset?.ngModel || '';
    return (
      id === 'periodoMes' ||
      /mes|month|periodomes/i.test(name) ||
      /mes|month|periodomes/i.test(id) ||
      /mes|month|periodomes/i.test(ngModel)
    );
  });

  const hasAnhoSelect = selects.some((sel) => {
    const name = sel.name || sel.getAttribute?.('name') || '';
    const id = sel.id || sel.getAttribute?.('id') || '';
    const ngModel = sel.getAttribute?.('ng-model') || sel.dataset?.ngModel || '';
    return (
      /anho|año|year|ejercicio|periodoanho/i.test(name) ||
      /anho|año|year|ejercicio|periodoanho/i.test(id) ||
      /anho|año|year|ejercicio|periodoanho/i.test(ngModel)
    );
  });

  const hasConsultarButton = Array.from(
    document.querySelectorAll('button, input[type="button"], input[type="submit"]')
  ).some((b) => {
    const txt = (b.textContent || b.value || '').toLowerCase().trim();
    return txt === 'consultar' || txt.includes('consultar');
  });

  const hasPeriodSelect = selects.some((sel) => {
    const options = Array.from(sel.options || []);
    return options.some((opt) => {
      const txt = (opt.text || '').toLowerCase();
      const val = (opt.value || '').trim();
      return (
        val === '2026' ||
        txt.includes('2026') ||
        val.includes('2026') ||
        txt.includes('febrero') ||
        val === '2' ||
        val === '02' ||
        val.endsWith(':02') ||
        val.endsWith(':2')
      );
    });
  });

  const hasInitialRcvScreen =
    (hasRutSelect && (hasMesSelect || hasAnhoSelect)) ||
    (hasMesSelect && hasAnhoSelect) ||
    (hasRutSelect && hasConsultarButton);

  const hasRcvControls = hasRcvRoot || hasInitialRcvScreen || hasPeriodSelect || selects.length >= 2;

  const hasLoginForm = Boolean(
    document.querySelector('form#form-login, #rutcntr, #form1, form#login-form') &&
    document.querySelector('input[type="password"]')
  );
  const bodyText = (document.body?.innerText || '').toLowerCase();
  const isPublic =
    hasLoginForm ||
    (!hasInitialRcvScreen &&
      !hasRcvRoot &&
      (bodyText.includes('ingrese su rut y clave') ||
        bodyText.includes('iniciar sesión') ||
        bodyText.includes('ingreso al sii')));

  const rutSelects = Array.from(
    document.querySelectorAll(
      'select[name="rut" i], select[ng-model="rut" i], select[data-ng-model="rut" i], select[name*="rut" i], select[id*="rut" i], select[name*="contribuyente" i], select#rutContribuyente, select[ng-model*="rut" i], select[data-ng-model*="rut" i]'
    )
  );

  const selectOptionRuts = [];
  const selectedOptionTexts = [];
  const selectedOptionValues = [];
  let selectHasOptions = false;

  for (const sel of rutSelects) {
    const options = Array.from(sel.options || []);
    if (options.length > 0) {
      selectHasOptions = true;
    }
    const selected = sel.selectedOptions
      ? Array.from(sel.selectedOptions)
      : options.filter((o) => Boolean(o.selected));

    for (const opt of selected) {
      const optVal = (opt.value || '').trim();
      const optTxt = (opt.text || opt.textContent || '').trim();
      selectedOptionValues.push(optVal);
      selectedOptionTexts.push(optTxt);
      selectOptionRuts.push(optTxt, optVal);
    }
  }

  const headerSelectors = [
    '#myRut',
    '.user-info',
    '.rut-contribuyente',
    'span[id*="rut" i]',
    'div[id*="header" i]',
    '#headingUser',
    '.info-contribuyente',
    'header .user-name',
    '.navbar .user',
  ];

  const headerTexts = [];
  for (const sel of headerSelectors) {
    const el = document.querySelector(sel);
    if (el?.textContent) {
      headerTexts.push(el.textContent.trim());
    }
  }

  return {
    hasRcvControls,
    selectOptionRuts,
    selectHasOptions,
    selectedOptionTexts,
    selectedOptionValues,
    headerRuts: headerTexts,
    headerText: headerTexts.join(' '),
    isPublicOrLoginPage: isPublic,
  };
}

function extractSelectedContributorRuts(evalResult: ContributorEvalDom): string[] {
  const textRuts = evalResult.selectedOptionTexts
    ? extractUniqueRuts(evalResult.selectedOptionTexts.join(' '))
    : [];

  if (textRuts.length > 0) {
    return textRuts;
  }

  const fallbackStrings = [
    ...(evalResult.selectedOptionValues || []),
    ...(evalResult.selectOptionRuts || []),
  ];
  return extractUniqueRuts(fallbackStrings.join(' '));
}

function inspectHeaderRuts(evalResult: ContributorEvalDom, normalizedExpected: string): boolean | null {
  const headerStrings = [
    ...(evalResult.headerRuts || []),
    ...(evalResult.headerText ? [evalResult.headerText] : []),
  ];
  const headerMatches = extractUniqueRuts(headerStrings.join(' '));
  if (headerMatches.length === 1) {
    return headerMatches[0] === normalizedExpected;
  }
  if (headerMatches.length > 1) {
    return false;
  }
  return null;
}

/**
 * Inspecciona los datos DOM evaluados y determina si la identidad del contribuyente coincide,
 * si pertenece a otro contribuyente o si aún no está cargada (null).
 */
export function inspectActiveContributorDom(
  evalResult: ContributorEvalDom,
  normalizedExpected: string
): boolean | null {
  if (evalResult.isPublicOrLoginPage) {
    return false;
  }

  const hasControls =
    evalResult.hasRcvControls ??
    Boolean(
      evalResult.selectHasOptions ||
      (evalResult.selectOptionRuts && evalResult.selectOptionRuts.length > 0) ||
      evalResult.headerText ||
      (evalResult.headerRuts && evalResult.headerRuts.length > 0)
    );

  if (!hasControls) {
    return null;
  }

  // 1. Selector de contribuyente activo
  const hasSelect = Boolean(
    evalResult.selectHasOptions ||
    (evalResult.selectOptionRuts && evalResult.selectOptionRuts.length > 0) ||
    (evalResult.selectedOptionTexts && evalResult.selectedOptionTexts.length > 0)
  );

  if (hasSelect) {
    const selectedMatches = extractSelectedContributorRuts(evalResult);
    if (selectedMatches.length === 1) {
      return selectedMatches[0] === normalizedExpected;
    }
    if (selectedMatches.length > 1) {
      return false;
    }
    // Si hay selector con opciones pero sin identidad seleccionada (selectedMatches.length === 0):
    // no fallback a cabecera; fail closed (null para mantener sondeo de hidratación)
    return null;
  }

  // 2. Cabecera autenticada acotada (solo si no hay selector de contribuyente con opciones)
  return inspectHeaderRuts(evalResult, normalizedExpected);
}

/**
 * Comprueba de forma segura si la página actual corresponde al portal RCV
 * y si la identidad activa coincide con el RUT esperado.
 */
async function checkPageIdentity(
  page: SiiPageLike,
  normalizedExpected: string,
  signal?: AbortSignal
): Promise<boolean | null> {
  let currentUrl = '';
  try {
    currentUrl = await page.url();
  } catch {
    return null;
  }

  if (!isExactRcvPortalUrl(currentUrl)) {
    return null;
  }

  if (signal?.aborted) {
    throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
  }

  try {
    const evalResult = await page.evaluate<ContributorEvalDom>(queryContributorDom);
    return inspectActiveContributorDom(evalResult, normalizedExpected);
  } catch {
    return null;
  }
}

/**
 * Normaliza y busca el RUT del contribuyente autenticado en los elementos de cabecera
 * y selección de contribuyente activo en la SPA de SII (consdcvinternetui).
 * Soporta sondeo continuo de hidratación hasta timeoutMs (0 por defecto para verificación única).
 * Falla cerrado si la URL no es del portal de RCV, si es página pública/login,
 * o si no hay controles RCV cargados.
 */
export async function verifyActiveContributorIdentity(
  page: SiiPageLike,
  expectedRut: string,
  signal?: AbortSignal,
  timeoutMs = 0,
  pollIntervalMs = 500
): Promise<IdentityVerificationResult> {
  const normalizedExpected = normalizeRut(expectedRut);
  if (!normalizedExpected) {
    return { verified: false };
  }

  const startTime = Date.now();

  do {
    if (signal?.aborted) {
      throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499);
    }

    const matchStatus = await checkPageIdentity(page, normalizedExpected, signal);
    if (matchStatus === true) {
      return { verified: true, contributorRut: normalizedExpected };
    }
    if (matchStatus === false) {
      return { verified: false };
    }

    if (Date.now() - startTime >= timeoutMs) {
      break;
    }

    await boundedHumanDelay(pollIntervalMs, pollIntervalMs, signal);
  } while (Date.now() - startTime < timeoutMs);

  return { verified: false };
}

export function extractUniqueRuts(text: string): string[] {
  const cleanForSearch = text.replaceAll('.', '');
  const matches = cleanForSearch.match(/\b\d{1,9}-[\dKk]\b|\b\d{7,9}[\dKk]\b/g) || [];
  const normalized = Array.from(
    new Set(
      matches
        .map((m) => normalizeRut(m))
        .filter((r) => r.length >= 3 && isValidRut(r))
    )
  );
  return normalized;
}

/**
 * Evalúa en el DOM el estado de renderizado de resultados en el portal RCV.
 * Detecta presencia del botón Consultar, pestañas Compras/Ventas, tablas de datos,
 * mensajes explícitos de sin movimientos y confirmación del período en los selects.
 */
export function queryRcvResultsStatus(expectedPeriod?: PeriodSelectionOptions): RcvDomResultsStatus {
  const buttons = Array.from(
    document.querySelectorAll('button, input[type="button"], input[type="submit"]')
  );
  const hasConsultarButton = buttons.some((b) => {
    const txt = (b.textContent || b.value || '').toLowerCase().trim();
    return txt === 'consultar' || txt.includes('consultar');
  });

  const tabElements = Array.from(
    document.querySelectorAll('a, button, [role="tab"], li, span, div.tab')
  );
  const comprasTabFound = tabElements.some((el) => {
    const href = (el.getAttribute ? el.getAttribute('href') : '') || '';
    const id = (el.id || (el.getAttribute ? el.getAttribute('id') : '') || '').toLowerCase();
    const txt = (el.textContent || '').trim().toLowerCase();
    if (txt.includes('ventas') || txt.includes('venta') || txt.includes('observad') || txt.includes('diferid')) return false;
    if (txt === 'pendientes' || txt === 'no incluir' || txt === 'reclamados') return false;
    return (
      id === 'tabcompra' ||
      id === 'tabcompras' ||
      id === 'tab-compra' ||
      id === 'tab-compras' ||
      href === '#compra/' ||
      href === '#compra' ||
      href === '#compras/' ||
      href === '#compras' ||
      txt === 'compra' ||
      txt === 'compras' ||
      txt.startsWith('compra') ||
      txt.startsWith('compras') ||
      txt.includes('registro de compra') ||
      txt.includes('registro de compras')
    );
  });
  const ventasTabFound = tabElements.some((el) => {
    const href = (el.getAttribute ? el.getAttribute('href') : '') || '';
    const id = (el.id || (el.getAttribute ? el.getAttribute('id') : '') || '').toLowerCase();
    const txt = (el.textContent || '').trim().toLowerCase();
    if (txt.includes('compras') || txt.includes('compra') || txt.includes('observad') || txt.includes('diferid') || txt.includes('boleta')) return false;
    return (
      id === 'tabventa' ||
      id === 'tabventas' ||
      id === 'tab-venta' ||
      id === 'tab-ventas' ||
      href === '#venta/' ||
      href === '#venta' ||
      href === '#ventas/' ||
      href === '#ventas' ||
      txt === 'venta' ||
      txt === 'ventas' ||
      txt.startsWith('venta') ||
      txt.startsWith('ventas') ||
      txt.includes('registro de venta') ||
      txt.includes('registro de ventas')
    );
  });
  const hasTabs = comprasTabFound || ventasTabFound;

  const tableCount = document.querySelectorAll('table').length;

  const rawBodyText = (document.body?.innerText || document.body?.textContent || '').toLowerCase();
  const bodyText = (rawBodyText.normalize ? rawBodyText.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : rawBodyText)
    .replace(/[\u00a0\s]+/g, ' ')
    .toLowerCase();

  // Textos reales observados en el portal del SII en períodos sin movimiento (ej. 'No hay información de Registro.', 'No hay información de Ventas.')
  const noMovementsPatterns = [
    'no hay informacion de registro',
    'no hay informacion de ventas',
    'no hay informacion de compras',
    'no hay informacion de',
    'no se encontraron registros',
    'no existen registros',
    'sin movimientos',
    'no se registran documentos',
    'sin información para el periodo',
    'sin informacion para el periodo',
    'no existen documentos registrados',
    'no hay documentos para mostrar',
    'sin registros para el periodo',
    'sin registros para el período',
    'no registra documentos',
  ];
  const matchedPattern = noMovementsPatterns.find(
    (pattern) => bodyText.includes(pattern) || rawBodyText.includes(pattern)
  );

  const alertEl = document.querySelector('.alert-danger, .alert-warning, [role="alert"]');
  const alertText = (alertEl?.textContent || '').trim();

  let periodConfirmed = true;
  if (expectedPeriod) {
    const selects = Array.from(document.querySelectorAll('select'));
    const monthNames = [
      'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
      'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
    ];
    const targetMonthName = monthNames[expectedPeriod.month - 1] ?? '';
    const targetYearStr = String(expectedPeriod.year);
    const targetMonthStr = expectedPeriod.month < 10 ? `0${expectedPeriod.month}` : String(expectedPeriod.month);
    const targetMonthNumStr = String(expectedPeriod.month);

    let detectedYear = false;
    let detectedMonth = false;
    let yearMatches = false;
    let monthMatches = false;

    for (const sel of selects) {
      const allOptions = Array.from(sel.options || []);
      const name = sel.name || sel.getAttribute?.('name') || '';
      const id = sel.id || sel.getAttribute?.('id') || '';
      const ngModel = sel.getAttribute?.('ng-model') || sel.dataset?.ngModel || '';

      const isYear =
        ngModel.toLowerCase().includes('periodoanho') ||
        /anho|año|year|ejercicio/i.test(name) ||
        /anho|año|year|ejercicio/i.test(id) ||
        allOptions.some((o) => {
          const v = (o.value || '').trim();
          const t = (o.text || '').trim();
          return (
            /^(19|20)\d{2}$/.test(v) ||
            /^(19|20)\d{2}$/.test(t) ||
            /(?:number|string):(19|20)\d{2}/.test(v)
          );
        });

      const isMonth =
        id === 'periodoMes' ||
        ngModel.toLowerCase().includes('periodomes') ||
        /mes|month|periodo/i.test(name) ||
        /mes|month|periodo/i.test(id) ||
        /mes|month|periodo/i.test(ngModel) ||
        allOptions.some((o) => {
          const t = (o.text || '').toLowerCase();
          const v = (o.value || '').trim();
          return (
            monthNames.some((m) => t.includes(m)) ||
            /^(0?[1-9]|1[0-2])$/.test(v) ||
            /(?:number|string):(0?[1-9]|1[0-2])$/.test(v)
          );
        });

      const selectedOptions = sel.selectedOptions
        ? Array.from(sel.selectedOptions)
        : allOptions.filter((o) => o.selected);

      if (
        selectedOptions.length === 0 &&
        typeof sel.selectedIndex === 'number' &&
        sel.selectedIndex >= 0
      ) {
        const opt = allOptions[sel.selectedIndex];
        if (opt) {
          selectedOptions.push(opt);
        }
      }

      if (isYear) {
        detectedYear = true;
        const selVal = (sel.value || '').trim();
        if (
          selVal === targetYearStr ||
          selVal === `number:${targetYearStr}` ||
          selVal === `string:${targetYearStr}` ||
          selVal.endsWith(`:${targetYearStr}`)
        ) {
          yearMatches = true;
        }
        for (const opt of selectedOptions) {
          const v = (opt.value || '').trim();
          const t = (opt.text || opt.textContent || '').trim();
          if (
            v === targetYearStr ||
            t === targetYearStr ||
            t.includes(targetYearStr) ||
            v.endsWith(`:${targetYearStr}`) ||
            v === `number:${targetYearStr}` ||
            v === `string:${targetYearStr}`
          ) {
            yearMatches = true;
          }
        }
      }

      if (isMonth) {
        detectedMonth = true;
        const selVal = (sel.value || '').trim();
        if (
          selVal === targetMonthStr ||
          selVal === targetMonthNumStr ||
          selVal === `string:${targetMonthStr}` ||
          selVal === `number:${targetMonthNumStr}` ||
          selVal === `string:${targetMonthNumStr}` ||
          selVal.endsWith(`:${targetMonthStr}`) ||
          selVal.endsWith(`:${targetMonthNumStr}`)
        ) {
          monthMatches = true;
        }
        for (const opt of selectedOptions) {
          const v = (opt.value || '').trim();
          const t = (opt.text || opt.textContent || '').toLowerCase().trim();
          if (
            v === targetMonthStr ||
            v === targetMonthNumStr ||
            t === targetMonthName ||
            t.includes(targetMonthName) ||
            v.endsWith(`:${targetMonthStr}`) ||
            v.endsWith(`:${targetMonthNumStr}`) ||
            v === `string:${targetMonthStr}` ||
            v === `number:${targetMonthNumStr}` ||
            v === `string:${targetMonthNumStr}`
          ) {
            monthMatches = true;
          }
        }
      }
    }

    if (!detectedYear || !detectedMonth || !yearMatches || !monthMatches) {
      periodConfirmed = false;
    }
  }

  const normAlertText = (alertText.normalize ? alertText.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : alertText)
    .replace(/[\u00a0\s]+/g, ' ')
    .toLowerCase();
  const alertIsNoMovements = Boolean(
    matchedPattern &&
    (normAlertText.includes(matchedPattern) || alertText.toLowerCase().includes(matchedPattern))
  );
  const isRealError = Boolean(alertEl && alertText.length > 0 && !alertIsNoMovements);

  return {
    hasConsultarButton,
    hasTabs,
    comprasTabFound,
    ventasTabFound,
    tableCount,
    hasNoMovementsMessage: Boolean(matchedPattern),
    noMovementsText: matchedPattern ?? undefined,
    hasErrorMessage: isRealError,
    errorMessage: isRealError ? alertText : undefined,
    periodConfirmed,
  };
}

/**
 * Consulta el estado del DOM en el portal RCV de forma asíncrona y segura.
 */
export async function checkRcvResultsStatus(
  page: SiiPageLike,
  expectedPeriod?: PeriodSelectionOptions
): Promise<RcvDomResultsStatus> {
  try {
    return await page.evaluate<RcvDomResultsStatus, PeriodSelectionOptions | undefined>(
      queryRcvResultsStatus,
      expectedPeriod
    );
  } catch {
    return {
      hasConsultarButton: false,
      hasTabs: false,
      comprasTabFound: false,
      ventasTabFound: false,
      tableCount: 0,
      hasNoMovementsMessage: false,
      hasErrorMessage: false,
      periodConfirmed: false,
    };
  }
}

/**
 * Comprueba si los controles de período (año/mes) coinciden exactamente con el período esperado.
 */
export async function verifyPeriodSelected(
  page: SiiPageLike,
  expectedPeriod: PeriodSelectionOptions,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) {
    throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499, undefined, { stage: 'verify_period' });
  }

  const status = await checkRcvResultsStatus(page, expectedPeriod);
  return status.periodConfirmed;
}

/**
 * Determina si los resultados del RCV ya se encuentran renderizados en la UI para el período especificado.
 */
export async function isRcvResultsLoaded(
  page: SiiPageLike,
  expectedPeriod?: PeriodSelectionOptions
): Promise<boolean> {
  const status = await checkRcvResultsStatus(page, expectedPeriod);
  return (
    (status.hasTabs || status.tableCount > 0 || status.hasNoMovementsMessage) &&
    status.periodConfirmed
  );
}

/**
 * Descubre los selects de año y mes en el DOM y resuelve sus valores objetivo.
 * Ejecutada en el navegador como JS puro serializable.
 */
export function evaluateSelectPeriodMetadata(params: {
  targetYear: string;
  targetMonth: string;
  targetMonthNum: string;
  targetMonthName: string;
}) {
  const { targetYear, targetMonth, targetMonthNum, targetMonthName } = params;
  const selects = Array.from(document.querySelectorAll('select'));
  if (selects.length === 0) {
    return {
      selectCount: 0,
      yearSelectIndex: -1,
      monthSelectIndex: -1,
      yearValue: '',
      monthValue: '',
    };
  }

  let yearSelectIndex = -1;
  let monthSelectIndex = -1;

  // Primero: búsqueda por atributos específicos observados en la SPA (id, name, ng-model)
  selects.forEach((sel, idx) => {
    const name = sel.name || sel.getAttribute?.('name') || '';
    const id = sel.id || sel.getAttribute?.('id') || '';
    const ngModel = sel.getAttribute?.('ng-model') || sel.dataset?.ngModel || '';

    const isAnhoAttr =
      ngModel.toLowerCase().includes('periodoanho') ||
      /anho|año|year|ejercicio/i.test(name) ||
      /anho|año|year|ejercicio/i.test(id);

    const isMesAttr =
      id === 'periodoMes' ||
      ngModel.toLowerCase().includes('periodomes') ||
      /mes|month/i.test(name) ||
      /mes|month/i.test(id);

    if (isAnhoAttr && yearSelectIndex === -1) {
      yearSelectIndex = idx;
    }
    if (isMesAttr && monthSelectIndex === -1) {
      monthSelectIndex = idx;
    }
  });

  // Si no se hallaron por atributos, buscar por opciones
  if (yearSelectIndex === -1 || monthSelectIndex === -1) {
    selects.forEach((sel, idx) => {
      const options = Array.from(sel.options || []);
      const hasYear = options.some((opt) => {
        const v = (opt.value || '').trim();
        const t = (opt.text || opt.textContent || '').trim().toLowerCase();
        return (
          v === targetYear ||
          t === targetYear ||
          t.includes(targetYear) ||
          v.endsWith(`:${targetYear}`) ||
          v === `number:${targetYear}` ||
          v === `string:${targetYear}`
        );
      });
      if (hasYear && yearSelectIndex === -1 && idx !== monthSelectIndex) {
        yearSelectIndex = idx;
      }

      const hasMonth = options.some((opt) => {
        const v = (opt.value || '').trim();
        const t = (opt.text || opt.textContent || '').trim().toLowerCase();
        return (
          v === targetMonth ||
          v === targetMonthNum ||
          t === targetMonthName ||
          t.includes(targetMonthName) ||
          v.endsWith(`:${targetMonth}`) ||
          v.endsWith(`:${targetMonthNum}`) ||
          v === `string:${targetMonth}` ||
          v === `number:${targetMonthNum}`
        );
      });
      if (hasMonth && monthSelectIndex === -1 && idx !== yearSelectIndex) {
        monthSelectIndex = idx;
      }
    });
  }

  // Resolver los valores exactos para año y mes
  let yearValue = '';
  let monthValue = '';

  const periodTargets = [
    {
      index: yearSelectIndex,
      exact: [targetYear],
      prefixes: [`number:${targetYear}`, `string:${targetYear}`, `:${targetYear}`],
      text: targetYear,
      isYear: true,
    },
    {
      index: monthSelectIndex,
      exact: [targetMonth, targetMonthNum],
      prefixes: [
        `string:${targetMonth}`,
        `number:${targetMonthNum}`,
        `string:${targetMonthNum}`,
        `:${targetMonth}`,
        `:${targetMonthNum}`,
      ],
      text: targetMonthName,
      isYear: false,
    },
  ];

  for (const item of periodTargets) {
    if (item.index < 0) continue;
    const sel = selects[item.index];
    if (!sel) continue;
    const options = Array.from(sel.options || []);
    let resolved = '';

    // 1. Exact flat value ('02', '2026')
    for (const opt of options) {
      const v = (opt.value || '').trim();
      if (item.exact.includes(v)) {
        resolved = opt.value ?? '';
        break;
      }
    }

    // 2. Prefix value ('number:2026', 'string:02')
    if (!resolved) {
      for (const opt of options) {
        const v = (opt.value || '').trim();
        if (
          item.prefixes.some(
            (p) => v === p || (v.includes(':') && v.endsWith(`:${item.exact[0]}`))
          )
        ) {
          resolved = opt.value ?? '';
          break;
        }
      }
    }

    // 3. Fallback by text ('Febrero', '2026')
    if (!resolved && item.text) {
      for (const opt of options) {
        const t = (opt.text || opt.textContent || '').trim().toLowerCase();
        if (t === item.text.toLowerCase() || t.includes(item.text.toLowerCase())) {
          resolved = opt.value ?? '';
          break;
        }
      }
    }

    if (item.isYear) {
      yearValue = resolved;
    } else {
      monthValue = resolved;
    }
  }

  return {
    selectCount: selects.length,
    yearSelectIndex,
    monthSelectIndex,
    yearValue,
    monthValue,
  };
}

/**
 * Sincroniza valores seleccionados y eventos nativos / Angular en el DOM de RCV.
 * Ejecutada en el navegador como JS puro serializable.
 */
export function evaluateSyncAngularPeriod(params: {
  yearIdx: number;
  monthIdx: number;
  yVal: string;
  mVal: string;
  targetYear: string;
  targetMonth: string;
  targetMonthNum: string;
  targetMonthName: string;
}) {
  const { yearIdx, monthIdx, yVal, mVal, targetYear, targetMonth, targetMonthNum, targetMonthName } = params;
  const selects = Array.from(document.querySelectorAll('select'));
  let angularAvailable = false;
  let angularError = false;

  const win =
    selects[0]?.ownerDocument?.defaultView ||
    (typeof window !== 'undefined' ? window : null);

  if (win?.angular && typeof win.angular.element === 'function') {
    angularAvailable = true;
  }

  const syncTargets = [
    {
      index: yearIdx,
      val: yVal,
      exact: [targetYear],
      prefixes: [`number:${targetYear}`, `string:${targetYear}`, `:${targetYear}`],
      text: targetYear,
    },
    {
      index: monthIdx,
      val: mVal,
      exact: [targetMonth, targetMonthNum],
      prefixes: [
        `string:${targetMonth}`,
        `number:${targetMonthNum}`,
        `string:${targetMonthNum}`,
        `:${targetMonth}`,
        `:${targetMonthNum}`,
      ],
      text: targetMonthName,
    },
  ];

  for (const item of syncTargets) {
    const sel = selects[item.index];
    if (!sel) continue;
    const options = Array.from(sel.options || []);
    let matchedIndex = -1;

    // 1. Buscar opción por value exacto plano ('02', '2026' o val)
    if (item.val) {
      matchedIndex = options.findIndex((opt) => (opt.value || '').trim() === item.val.trim());
    }
    if (matchedIndex === -1 && item.exact.length > 0) {
      matchedIndex = options.findIndex((opt) => {
        const v = (opt.value || '').trim();
        return item.exact.includes(v);
      });
    }

    // 2. Soporte para prefijos si aparecieran (Angular number:2026, string:02, :02)
    if (matchedIndex === -1 && item.prefixes.length > 0) {
      matchedIndex = options.findIndex((opt) => {
        const v = (opt.value || '').trim();
        return item.prefixes.some((p) => v === p || (v.includes(':') && v.endsWith(`:${item.exact[0]}`)));
      });
    }

    // 3. Fallback por texto ('Febrero', '2026')
    if (matchedIndex === -1 && item.text) {
      matchedIndex = options.findIndex((opt) => {
        const t = (opt.text || opt.textContent || '').trim().toLowerCase();
        return t === item.text.toLowerCase() || t.includes(item.text.toLowerCase());
      });
    }

    const matchedOpt = matchedIndex >= 0 ? options[matchedIndex] : undefined;

    // Setear value y selectedIndex
    if (matchedOpt?.value !== undefined) {
      sel.value = matchedOpt.value;
    } else if (item.val) {
      sel.value = item.val;
    }
    if (matchedIndex >= 0) {
      sel.selectedIndex = matchedIndex;
      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        if (opt) {
          opt.selected = (i === matchedIndex);
        }
      }
    }

    // Disparar input/change bubbles
    const EventCtor = win?.Event || (typeof Event !== 'undefined' ? Event : null);
    if (typeof EventCtor === 'function' && typeof sel.dispatchEvent === 'function') {
      try {
        sel.dispatchEvent(new EventCtor('input', { bubbles: true }));
      } catch {
        // safe
      }
      try {
        sel.dispatchEvent(new EventCtor('change', { bubbles: true }));
      } catch {
        // safe
      }
    }

    // 3. Si existe angular.element usar triggerHandler('change') protegido en try sin romper si controlador no disponible
    try {
      if (win?.angular && typeof win.angular.element === 'function') {
        const ngEl = win.angular.element(sel);
        if (ngEl) {
          try {
            if (typeof ngEl.triggerHandler === 'function') {
              ngEl.triggerHandler('change');
            }
          } catch {
            // ignorar fallo de triggerHandler
          }

          try {
            const ngModel = typeof ngEl.controller === 'function' ? ngEl.controller('ngModel') : undefined;
            const finalVal = matchedOpt?.value ?? sel.value;
            if (ngModel && finalVal !== undefined) {
              ngModel.$setViewValue?.(finalVal);
              ngModel.$render?.();
            }
          } catch {
            // controlador no disponible o no compatible: no romper
          }

          try {
            const scope = typeof ngEl.scope === 'function' ? ngEl.scope() : undefined;
            if (scope && !scope.$$phase && typeof scope.$apply === 'function') {
              scope.$apply();
            }
          } catch {
            // scope no disponible: no romper
          }
        }
      }
    } catch {
      angularError = true;
    }

    // Respaldo adicional con jQuery triggerHandler si existe
    try {
      const jq = win?.jQuery || win?.$;
      if (typeof jq === 'function') {
        const jqEl = jq(sel);
        if (jqEl && typeof jqEl.triggerHandler === 'function') {
          jqEl.triggerHandler('change');
        }
      }
    } catch {
      // safe
    }
  }

  return { angularAvailable, angularError };
}

/**
 * Verifica la existencia del botón Consultar en el DOM.
 * Ejecutada en el navegador como JS puro serializable.
 */
export function evaluateHasConsultarButton() {
  const buttons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'));
  const btn = buttons.find((b) => {
    const txt = (b.textContent || b.value || '').toLowerCase().trim();
    return txt === 'consultar' || txt === 'buscar' || txt.includes('consultar');
  });
  return Boolean(btn);
}

/**
 * Dispara el click de respaldo en el botón Consultar en el DOM.
 * Ejecutada en el navegador como JS puro serializable.
 */
export function evaluateClickConsultarFallback() {
  const buttons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'));
  const btn = buttons.find((b) => {
    const txt = (b.textContent || b.value || '').toLowerCase().trim();
    return txt === 'consultar' || txt === 'buscar' || txt.includes('consultar');
  });
  if (btn && typeof btn.click === 'function') {
    btn.click();
  }
}

/**
 * Intenta hacer click en el botón Consultar y retorna true si se ejecutó.
 * Ejecutada en el navegador como JS puro serializable.
 */
export function evaluateClickConsultar() {
  const buttons = Array.from(
    document.querySelectorAll('button, input[type="button"], input[type="submit"]')
  );
  const btn = buttons.find((b) => {
    const txt = (b.textContent || b.value || '').toLowerCase().trim();
    return txt === 'consultar' || txt.includes('consultar');
  });
  if (btn && typeof btn.click === 'function') {
    btn.click();
    return true;
  }
  return false;
}

/**
 * Descubre y selecciona el período (año 2026, mes febrero) en la SPA de RCV.
 * Utiliza inspectores acotados de opciones en selectores y locator.selectOption de SDK,
 * y dispara correctamente los eventos de cambio estándar y de AngularJS (ng-model).
 * Falla de forma cerrada (fail-closed) si no se puede verificar la selección.
 */
export async function selectRcvPeriod(
  page: SiiPageLike,
  period: PeriodSelectionOptions,
  signal?: AbortSignal,
  options?: SelectPeriodOptions
): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499, undefined, { stage: 'period_selection' });
  }

  const { year, month } = period;
  const monthStr = month < 10 ? `0${month}` : `${month}`;
  const monthNumStr = String(month);
  const yearStr = String(year);
  const monthNames = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ];
  const targetMonthName = monthNames[month - 1]!;

  // 1. Descubrir los selects de año y mes en el DOM y sus valores
  let selectMetadata: {
    selectCount: number;
    yearSelectIndex: number;
    monthSelectIndex: number;
    yearValue: string;
    monthValue: string;
  };

  try {
    selectMetadata = await page.evaluate<{
      selectCount: number;
      yearSelectIndex: number;
      monthSelectIndex: number;
      yearValue: string;
      monthValue: string;
    }, {
      targetYear: string;
      targetMonth: string;
      targetMonthNum: string;
      targetMonthName: string;
    }>(
      evaluateSelectPeriodMetadata,
      {
        targetYear: yearStr,
        targetMonth: monthStr,
        targetMonthNum: monthNumStr,
        targetMonthName,
      }
    );
  } catch (err: unknown) {
    handleNavigationError(err, 'period_selection');
  }

  if (selectMetadata.selectCount === 0) {
    throw new AppError(
      'PERIOD_SELECT_FAILED',
      'No se encontraron controles de selección de período en el portal RCV.',
      502,
      undefined,
      { stage: 'period_selection' }
    );
  }

  if (selectMetadata.yearSelectIndex === -1 || selectMetadata.monthSelectIndex === -1) {
    throw new AppError(
      'PERIOD_SELECT_FAILED',
      'No fue posible identificar los controles de selección de período (año/mes) en la SPA de RCV.',
      502,
      undefined,
      { stage: 'period_selection' }
    );
  }

  if (!selectMetadata.yearValue || !selectMetadata.monthValue) {
    throw new AppError(
      'PERIOD_SELECT_FAILED',
      'No fue posible identificar o hacer coincidir las opciones del período solicitado (año/mes) en la SPA de RCV.',
      502,
      undefined,
      { stage: 'period_selection' }
    );
  }

  // 2. Establecer valores y disparar eventos de cambio nativos y de AngularJS en el DOM
  let syncResult: { angularAvailable: boolean; angularError: boolean };
  try {
    syncResult = await page.evaluate<{
      angularAvailable: boolean;
      angularError: boolean;
    }, {
      yearIdx: number;
      monthIdx: number;
      yVal: string;
      mVal: string;
      targetYear: string;
      targetMonth: string;
      targetMonthNum: string;
      targetMonthName: string;
    }>(
      evaluateSyncAngularPeriod,
      {
        yearIdx: selectMetadata.yearSelectIndex,
        monthIdx: selectMetadata.monthSelectIndex,
        yVal: selectMetadata.yearValue,
        mVal: selectMetadata.monthValue,
        targetYear: yearStr,
        targetMonth: monthStr,
        targetMonthNum: monthNumStr,
        targetMonthName,
      }
    );
  } catch (err: unknown) {
    handleNavigationError(err, 'period_selection');
  }

  // 4. NO lanzar EVALUATE_FAILED por ausencia de API angular.
  // Solo si explícitamente se exigió requireAngular, lanzar ANGULAR_NOT_AVAILABLE.
  if (options?.requireAngular && !syncResult?.angularAvailable) {
    throw new AppError(
      'ANGULAR_NOT_AVAILABLE',
      'El framework AngularJS no se encuentra disponible en la página del RCV.',
      502,
      undefined,
      { stage: 'period_selection' }
    );
  }

  if (options?.requireAngular && syncResult?.angularError) {
    throw new AppError(
      'ANGULAR_NOT_AVAILABLE',
      'Fallo al sincronizar los controles con AngularJS en la página del RCV.',
      502,
      undefined,
      { stage: 'period_selection' }
    );
  }

  // Sincronizar también con locators SDK si existen y están soportados
  try {
    if (page.locator && selectMetadata.yearSelectIndex >= 0 && selectMetadata.yearValue) {
      const yearSelectLocator = page.locator('select').nth(selectMetadata.yearSelectIndex);
      await yearSelectLocator.selectOption(selectMetadata.yearValue).catch(() => {});
    }
  } catch {
    // Locator opcional
  }

  try {
    if (page.locator && selectMetadata.monthSelectIndex >= 0 && selectMetadata.monthValue) {
      const monthSelectLocator = page.locator('select').nth(selectMetadata.monthSelectIndex);
      await monthSelectLocator.selectOption(selectMetadata.monthValue).catch(() => {});
    }
  } catch {
    // Locator opcional
  }

  await boundedHumanDelay(250, 450, signal);

  // 4. Si se solicitó click explícito en consultar dentro de selectRcvPeriod
  if (options?.clickConsultar) {
    let hasConsultarButton = false;
    try {
      hasConsultarButton = await page.evaluate<boolean>(evaluateHasConsultarButton);
    } catch (err: unknown) {
      handleNavigationError(err, 'query_button');
    }

    if (!hasConsultarButton) {
      throw new AppError(
        'QUERY_BUTTON_MISSING',
        'No se encontró el botón "Consultar" en el portal de RCV.',
        502,
        undefined,
        { stage: 'query_button' }
      );
    }

    try {
      if (page.locator) {
        const consultarLocator = page.locator('button:has-text("Consultar"), input[value*="Consultar" i]').first();
        await consultarLocator.click();
      } else {
        throw new Error('page.locator not available');
      }
    } catch {
      await page.evaluate(evaluateClickConsultarFallback);
    }
    await boundedHumanDelay(400, 800, signal);
  }
}

/**
 * Asegura que los resultados del RCV para el período objetivo estén renderizados en la UI.
 * Si ya están cargados para el período, evita reconsultar innecesariamente.
 * Si no están cargados, selecciona el período objetivo, dispara los cambios Angular,
 * hace click en "Consultar" UNA vez y espera el render de resultados antes de proceder a pestañas o descarga.
 */
export async function ensureRcvResultsLoaded(
  page: SiiPageLike,
  period: PeriodSelectionOptions,
  signal?: AbortSignal,
  timeoutMs = 20000,
  pollIntervalMs = 300,
  options?: SelectPeriodOptions
): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499, undefined, { stage: 'ensure_results' });
  }

  // 1. Si los resultados ya están cargados para el período objetivo, evitar reconsultar
  const isLoaded = await isRcvResultsLoaded(page, period);
  if (isLoaded) {
    return;
  }

  // 2. Seleccionar período objetivo y disparar change Angular correctamente
  await selectRcvPeriod(page, period, signal, options);

  // 3. Hacer click Consultar UNA vez
  let clicked = false;
  try {
    clicked = await page.evaluate<boolean>(evaluateClickConsultar);
  } catch (err: unknown) {
    handleNavigationError(err, 'query_button');
  }

  if (!clicked) {
    let locatorClicked = false;
    try {
      if (page.locator) {
        const consultarLocator = page.locator('button:has-text("Consultar"), input[value*="Consultar" i]').first();
        await consultarLocator.click({ timeout: 2000 });
        locatorClicked = true;
      }
    } catch {
      locatorClicked = false;
    }
    if (!locatorClicked) {
      throw new AppError(
        'QUERY_BUTTON_MISSING',
        'No fue posible activar el botón "Consultar" en el portal de RCV.',
        502,
        undefined,
        { stage: 'query_button' }
      );
    }
  }

  // 4. Esperar el render de resultados antes de pestañas/descarga (sondeo acotado)
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (signal?.aborted) {
      throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499, undefined, { stage: 'results_render' });
    }

    await boundedHumanDelay(pollIntervalMs, pollIntervalMs + 100, signal);

    let status: RcvDomResultsStatus;
    try {
      status = await checkRcvResultsStatus(page, period);
    } catch (err: unknown) {
      handleNavigationError(err, 'results_render');
    }

    const rendered =
      (status.hasTabs || status.tableCount > 0 || status.hasNoMovementsMessage) &&
      status.periodConfirmed;

    if (rendered) {
      return;
    }

    if (status.hasErrorMessage && !status.hasTabs && status.tableCount === 0) {
      throw new AppError(
        'RESULTS_NOT_RENDERED',
        'El portal de RCV mostró un mensaje de error al consultar el período.',
        502,
        undefined,
        { stage: 'results_render' }
      );
    }
  }

  throw new AppError(
    'RESULTS_NOT_RENDERED',
    'Tiempo de espera agotado al consultar o renderizar resultados del RCV.',
    504,
    undefined,
    { stage: 'results_render' }
  );
}

/**
 * Hace click en la pestaña correspondiente (Compras/Ventas) en el DOM.
 * Soporta estrategias de activación por click en anchor y navegación por hash.
 * Ejecutada en el navegador como JS puro serializable.
 */
export function evaluateSwitchRcvTab(
  targetTabOrOptions: string | { targetTab: string; useHash?: boolean }
): boolean {
  var targetTab =
    typeof targetTabOrOptions === 'string'
      ? targetTabOrOptions
      : (targetTabOrOptions && targetTabOrOptions.targetTab ? targetTabOrOptions.targetTab : '');
  var useHash =
    typeof targetTabOrOptions === 'object' && targetTabOrOptions !== null
      ? Boolean(targetTabOrOptions.useHash)
      : false;
  var targetLower = targetTab.toLowerCase();
  var isCompras = targetLower.indexOf('compra') === 0;
  var oppositeLower = isCompras ? 'ventas' : 'compras';
  var targetWords = isCompras ? ['compra', 'compras'] : ['venta', 'ventas'];
  var oppositeWords = isCompras ? ['venta', oppositeLower] : ['compra', oppositeLower];
  var targetHrefPatterns = isCompras
    ? ['#compra/', '#compra', '#compras/', '#compras']
    : ['#venta/', '#venta', '#ventas/', '#ventas'];
  var targetId = isCompras ? 'tabcompra' : 'tabventa';
  var targetHash = isCompras ? '#compra/' : '#venta/';

  var win = typeof window !== 'undefined' ? window : null;

  // @ts-expect-error browser runtime helper parameter
  var normalizeText = (0, function(str) {
    if (!str) return '';
    return str
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  });

  // @ts-expect-error browser runtime helper parameter
  var isForbidden = (0, function(el) {
    var txt = normalizeText(el.textContent || el.value || '');
    var href = (el.getAttribute ? el.getAttribute('href') : '') || '';
    var hrefNorm = href.trim().toLowerCase();
    var id = (el.id || (el.getAttribute ? el.getAttribute('id') : '') || '').toLowerCase();

    if (
      txt.indexOf('observad') !== -1 ||
      txt.indexOf('diferid') !== -1 ||
      txt.indexOf('boleta') !== -1 ||
      hrefNorm.indexOf('observad') !== -1 ||
      hrefNorm.indexOf('diferid') !== -1 ||
      hrefNorm.indexOf('boleta') !== -1 ||
      id.indexOf('observad') !== -1 ||
      id.indexOf('diferid') !== -1
    ) {
      return true;
    }

    if (txt === 'pendientes' || txt === 'no incluir' || txt === 'reclamados') {
      return true;
    }
    return false;
  });

  var hashUpdated = false;
  if (useHash && win && win.location) {
    try {
      if (win.location.hash !== targetHash) {
        win.location.hash = targetHash;
        hashUpdated = true;
      }
    } catch {
      // safe
    }
    try {
      var EventCtor = win.Event || (typeof Event !== 'undefined' ? Event : null);
      if (typeof EventCtor === 'function' && typeof win.dispatchEvent === 'function') {
        win.dispatchEvent(new EventCtor('hashchange'));
      }
    } catch {
      // safe
    }
  }

  var matched = null;

  // 1. Localizar por href exacto '#compra/'/'#venta/' o id tabCompra
  var anchors = Array.from(document.querySelectorAll('a, button, [role="tab"]') || []);

  // Prioridad 1A: por id exacto (ej: tabCompra)
  for (var i = 0; i < anchors.length; i++) {
    var el = anchors[i];
    if (!el || isForbidden(el)) continue;
    var elId = (el.id || (el.getAttribute ? el.getAttribute('id') : '') || '').toLowerCase();
    if (elId === targetId || elId === (targetId + 's') || elId === ('tab-' + targetWords[0]) || elId === ('tab-' + targetWords[1])) {
      matched = el;
      break;
    }
  }

  // Prioridad 1B: por href exacto '#compra/' o '#venta/'
  if (!matched) {
    for (var j = 0; j < anchors.length; j++) {
      var el2 = anchors[j];
      if (!el2 || isForbidden(el2)) continue;
      var href = (el2.getAttribute ? el2.getAttribute('href') : '') || '';
      var hrefNorm = href.trim().toLowerCase();
      for (var p = 0; p < targetHrefPatterns.length; p++) {
        if (hrefNorm === targetHrefPatterns[p]) {
          matched = el2;
          break;
        }
      }
      if (matched) break;
    }
  }

  // Prioridad 1C: por href que comience con '#compra' o '#venta'
  if (!matched) {
    for (var k = 0; k < anchors.length; k++) {
      var el3 = anchors[k];
      if (!el3 || isForbidden(el3)) continue;
      var h = (el3.getAttribute ? el3.getAttribute('href') : '') || '';
      var hNorm = h.trim().toLowerCase();
      if (hNorm.indexOf('#' + targetWords[0]) === 0 || hNorm.indexOf('#' + targetWords[1]) === 0) {
        matched = el3;
        break;
      }
    }
  }

  // Prioridad 2: por texto exacto COMPRA / VENTA (singular o plural)
  if (!matched) {
    var candidates = Array.from(document.querySelectorAll('a, button, [role="tab"], li, span, div.tab') || []);
    for (var m = 0; m < candidates.length; m++) {
      var el4 = candidates[m];
      if (!el4 || isForbidden(el4)) continue;
      var txt = normalizeText(el4.textContent || el4.value || '');
      var hasOpp = false;
      for (var o = 0; o < oppositeWords.length; o++) {
        if (txt.indexOf(oppositeWords[o]) !== -1) {
          hasOpp = true;
          break;
        }
      }
      if (hasOpp) continue;

      var isExactMatch =
        txt === targetWords[0] ||
        txt === targetWords[1] ||
        txt === ('registro de ' + targetWords[0]) ||
        txt === ('registro de ' + targetWords[1]);

      if (isExactMatch) {
        var aChild = el4.querySelector ? el4.querySelector('a') : null;
        matched = aChild || el4;
        break;
      }
    }
  }

  if (matched && typeof matched.click === 'function') {
    try {
      matched.click();
    } catch {
      // safe
    }
    var matchedWin = matched.ownerDocument ? matched.ownerDocument.defaultView : win;
    try {
      if (matchedWin && matchedWin.angular && typeof matchedWin.angular.element === 'function') {
        var ngEl = matchedWin.angular.element(matched);
        if (ngEl) {
          if (typeof ngEl.triggerHandler === 'function') {
            ngEl.triggerHandler('click');
          }
          var scope = typeof ngEl.scope === 'function' ? ngEl.scope() : null;
          if (scope && !scope.$$phase && typeof scope.$apply === 'function') {
            scope.$apply();
          }
        }
      }
    } catch {
      // safe
    }
    return true;
  }

  return Boolean(hashUpdated);
}

export interface SwitchSubtabResult {
  subtabsFound: boolean;
  registroClicked: boolean;
  alreadyActive: boolean;
}

/**
 * Detecta y activa explícitamente la subpestaña 'Registro' en COMPRA si existen subpestañas
 * (Registro, Pendientes, No Incluir, Reclamados), sin tocar las demás subpestañas.
 * Ejecutada en el navegador como JS puro serializable.
 */
export function evaluateSwitchComprasRegistroSubtab(): SwitchSubtabResult {
  // @ts-expect-error browser runtime helper parameter
  const normalizeText = (0, function(str) {
    if (!str) return '';
    return str
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  });

  // @ts-expect-error browser runtime helper parameter
  const isForbiddenSubtab = (0, function(el) {
    const txt = normalizeText(el.textContent || el.value || '');
    const href = (el.getAttribute ? el.getAttribute('href') : '') || '';
    const hrefNorm = href.trim().toLowerCase();
    const id = (el.id || (el.getAttribute ? el.getAttribute('id') : '') || '').toLowerCase();

    if (
      txt.includes('observad') ||
      txt.includes('diferid') ||
      txt.includes('boleta') ||
      txt.includes('resumen') ||
      hrefNorm.includes('observad') ||
      hrefNorm.includes('diferid') ||
      hrefNorm.includes('boleta') ||
      id.includes('observad') ||
      id.includes('diferid')
    ) {
      return true;
    }

    if (
      txt === 'pendientes' ||
      txt.includes('pendiente') ||
      txt === 'no incluir' ||
      txt.includes('no incluir') ||
      txt === 'reclamados' ||
      txt.includes('reclamado') ||
      hrefNorm.includes('pendiente') ||
      hrefNorm.includes('noincluir') ||
      hrefNorm.includes('no-incluir') ||
      hrefNorm.includes('reclamado') ||
      id.includes('pendiente') ||
      id.includes('noincluir') ||
      id.includes('no-incluir') ||
      id.includes('reclamado')
    ) {
      return true;
    }

    return false;
  });

  // 1. Detectar si existen subpestañas de compras en el documento
  const allSubtabCandidates = Array.from(
    document.querySelectorAll('a, button, [role="tab"], li, span')
  );

  let hasSubtabs = false;
  for (const el of allSubtabCandidates) {
    const txt = normalizeText(el.textContent || el.value || '');
    const href = (el.getAttribute ? el.getAttribute('href') : '') || '';
    const hrefNorm = href.trim().toLowerCase();

    if (
      txt === 'pendientes' ||
      txt === 'no incluir' ||
      txt === 'reclamados' ||
      hrefNorm.includes('pendiente') ||
      hrefNorm.includes('noincluir') ||
      hrefNorm.includes('reclamado')
    ) {
      hasSubtabs = true;
      break;
    }
  }

  // 2. Localizar el elemento correspondiente a la subpestaña 'Registro'
  const linkCandidates = Array.from(
    document.querySelectorAll('a, button, [role="tab"], li')
  );

  let registroEl = null;

  // Prioridad 1: por ID o href específico
  for (const el of linkCandidates) {
    if (isForbiddenSubtab(el)) continue;
    const id = (el.id || (el.getAttribute ? el.getAttribute('id') : '') || '').toLowerCase();
    const href = (el.getAttribute ? el.getAttribute('href') : '') || '';
    const hrefNorm = href.trim().toLowerCase();

    if (
      id === 'tabregistro' ||
      id === 'subtab-registro' ||
      id === 'subtabregistro' ||
      hrefNorm === '#registro' ||
      hrefNorm === '#registro/' ||
      hrefNorm === '#/compra/registro' ||
      hrefNorm.endsWith('/registro') ||
      hrefNorm.endsWith('/registro/') ||
      hrefNorm.includes('compraregistro') ||
      hrefNorm === '#compraregistro/' ||
      hrefNorm === '#compraregistro'
    ) {
      registroEl = el;
      break;
    }
  }

  // Prioridad 2: por texto exacto 'registro'
  if (!registroEl) {
    for (const el of linkCandidates) {
      if (isForbiddenSubtab(el)) continue;
      const txt = normalizeText(el.textContent || el.value || '');
      if (txt === 'registro') {
        const aChild = el.querySelector ? el.querySelector('a') : null;
        registroEl = aChild || el;
        break;
      }
    }
  }

  if (registroEl) {
    hasSubtabs = true;
  }

  if (!hasSubtabs || !registroEl) {
    return { subtabsFound: hasSubtabs, registroClicked: false, alreadyActive: false };
  }

  // Comprobar si ya está activa
  const parentLi = registroEl.closest ? registroEl.closest('li') : null;
  const isLiActive = Boolean(
    parentLi &&
    (parentLi.classList?.contains('active') || parentLi.getAttribute?.('aria-selected') === 'true')
  );
  const isSelfActive = Boolean(
    registroEl.classList?.contains('active') || registroEl.getAttribute?.('aria-selected') === 'true'
  );
  const win = registroEl.ownerDocument?.defaultView || (typeof window !== 'undefined' ? window : null);
  const hash = (win?.location?.hash || '').toLowerCase();
  const isHashActive = hash.indexOf('compraregistro') !== -1;
  const alreadyActive = isLiActive || isSelfActive || isHashActive;

  if (alreadyActive) {
    return {
      subtabsFound: true,
      registroClicked: false,
      alreadyActive: true,
    };
  }

  const childA = registroEl.querySelector ? registroEl.querySelector('a') : null;
  const targetToClick = childA || registroEl;

  let clicked = false;
  try {
    if (typeof targetToClick.click === 'function') {
      targetToClick.click();
      clicked = true;
    }
  } catch {
    // safe
  }

  try {
    if (win?.angular && typeof win.angular.element === 'function') {
      const ngEl = win.angular.element(targetToClick);
      if (ngEl) {
        ngEl.triggerHandler?.('click');
        const scope = ngEl.scope?.();
        if (scope && !scope.$$phase && typeof scope.$apply === 'function') {
          scope.$apply();
        }
      }
    }
  } catch {
    // safe
  }

  if (clicked && parentLi && !isLiActive) {
    try {
      parentLi.classList?.add('active');
    } catch {
      // safe
    }
  }

  return {
    subtabsFound: true,
    registroClicked: clicked,
    alreadyActive,
  };
}

/**
 * Inspecciona la pestaña activa de RCV en el DOM para verificar movimientos, botón de descarga y período.
 * Ejecutada en el navegador como JS puro serializable.
 */
export function evaluateInspectRcvActiveTab(params: {
  targetTab: string;
  expectedPeriod?: PeriodSelectionOptions | undefined;
}): EvaluateInspectResult {
  const targetTab = params.targetTab;
  const expectedPeriod = params.expectedPeriod;
  const isCompras = targetTab.toLowerCase().startsWith('compra');
  const targetWords = isCompras ? ['compra', 'compras'] : ['venta', 'ventas'];
  const oppositeWords = isCompras ? ['venta', 'ventas'] : ['compra', 'compras'];
  const targetHrefPatterns = isCompras
    ? ['#compra/', '#compra', '#compras/', '#compras']
    : ['#venta/', '#venta', '#ventas/', '#ventas'];
  const oppositeHrefPatterns = isCompras
    ? ['#venta/', '#venta', '#ventas/', '#ventas']
    : ['#compra/', '#compra', '#compras/', '#compras'];
  const targetId = isCompras ? 'tabcompra' : 'tabventa';

  // @ts-expect-error browser runtime helper parameter
  const normalizeText = (0, function(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .replace(/[\u00a0\s]+/g, ' ')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[\u00a0\s]+/g, ' ')
      .trim();
  });

  // Helper de visibilidad efectiva basado exclusivamente en el estado real de renderizado
  // @ts-expect-error browser runtime helper parameter
  const isElementVisible = (0, function(el) {
    if (!el) return false;
    if (el.hidden) return false;
    if (el.getAttribute && (el.getAttribute('hidden') !== null || el.getAttribute('aria-hidden') === 'true')) {
      return false;
    }

    const win = el.ownerDocument ? el.ownerDocument.defaultView : (typeof window !== 'undefined' ? window : null);
    const isJsdom = Boolean(win && win.navigator && win.navigator.userAgent && win.navigator.userAgent.indexOf('jsdom') !== -1);

    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    const hasGeometry = el.offsetParent !== null || Boolean(rect && (rect.width > 0 || rect.height > 0));
    if (!hasGeometry && !isJsdom) {
      return false;
    }

    let curr = el;
    const docElem = el.ownerDocument ? el.ownerDocument.documentElement : null;
    while (curr && curr !== docElem) {
      if (curr.hidden) return false;
      if (curr.getAttribute && (curr.getAttribute('hidden') !== null || curr.getAttribute('aria-hidden') === 'true')) {
        return false;
      }
      const s = curr.style;
      if (s && (s.display === 'none' || s.visibility === 'hidden')) {
        return false;
      }
      if (win && typeof win.getComputedStyle === 'function') {
        try {
          const comp = win.getComputedStyle(curr);
          if (comp && (comp.display === 'none' || comp.visibility === 'hidden')) {
            return false;
          }
        } catch {
          // safe
        }
      }
      curr = curr.parentElement;
    }

    return true;
  });

  // 2.1 Verificar si el período objetivo está confirmado en los controles de la SPA
  let periodConfirmed = true;
  if (expectedPeriod) {
    const selects = Array.from(document.querySelectorAll('select'));
    const monthNames = [
      'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
      'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
    ];
    const targetMonthName = monthNames[expectedPeriod.month - 1] ?? '';
    const targetYearStr = String(expectedPeriod.year);
    const targetMonthStr = expectedPeriod.month < 10 ? `0${expectedPeriod.month}` : String(expectedPeriod.month);
    const targetMonthNumStr = String(expectedPeriod.month);

    let detectedYearSelect = false;
    let detectedMonthSelect = false;
    let yearMatches = false;
    let monthMatches = false;

    for (const sel of selects) {
      const allOptions = Array.from(sel.options || []);
      const name = sel.name || sel.getAttribute?.('name') || '';
      const id = sel.id || sel.getAttribute?.('id') || '';
      const ngModel = sel.getAttribute?.('ng-model') || sel.dataset?.ngModel || '';

      const isYearSelect =
        allOptions.some((o) => {
          const v = (o.value || '').trim();
          const t = (o.text || '').trim();
          return (
            /^(19|20)\d{2}$/.test(v) ||
            /^(19|20)\d{2}$/.test(t) ||
            /(?:number|string):(19|20)\d{2}/.test(v)
          );
        }) ||
        /periodoanho|anho|año|year|ejercicio/i.test(name) ||
        /periodoanho|anho|año|year|ejercicio/i.test(id) ||
        /periodoanho|anho|año|year|ejercicio/i.test(ngModel);

      const isMonthSelect =
        id === 'periodoMes' ||
        ngModel.toLowerCase().includes('periodomes') ||
        allOptions.some((o) => {
          const t = (o.text || '').toLowerCase();
          const v = (o.value || '').trim();
          return (
            monthNames.some((m) => t.includes(m)) ||
            /^(0?[1-9]|1[0-2])$/.test(v) ||
            /(?:number|string):(0?[1-9]|1[0-2])$/.test(v)
          );
        }) ||
        /mes|month|periodo/i.test(name) ||
        /mes|month|periodo/i.test(id) ||
        /mes|month|periodo/i.test(ngModel);

      const selectedOptions = sel.selectedOptions
        ? Array.from(sel.selectedOptions)
        : allOptions.filter((o) => o.selected);

      if (
        selectedOptions.length === 0 &&
        typeof sel.selectedIndex === 'number' &&
        sel.selectedIndex >= 0
      ) {
        const opt = allOptions[sel.selectedIndex];
        if (opt) {
          selectedOptions.push(opt);
        }
      }

      if (isYearSelect) {
        detectedYearSelect = true;
        const selVal = (sel.value || '').trim();
        if (
          selVal === targetYearStr ||
          selVal === `number:${targetYearStr}` ||
          selVal === `string:${targetYearStr}` ||
          selVal.endsWith(`:${targetYearStr}`)
        ) {
          yearMatches = true;
        }
        for (const opt of selectedOptions) {
          const txt = (opt.text || opt.textContent || '').toLowerCase().trim();
          const val = (opt.value || '').trim();
          if (
            val === targetYearStr ||
            txt === targetYearStr ||
            txt.includes(targetYearStr) ||
            val.endsWith(`:${targetYearStr}`) ||
            val === `number:${targetYearStr}` ||
            val === `string:${targetYearStr}`
          ) {
            yearMatches = true;
          }
        }
      }

      if (isMonthSelect) {
        detectedMonthSelect = true;
        const selVal = (sel.value || '').trim();
        if (
          selVal === targetMonthStr ||
          selVal === targetMonthNumStr ||
          selVal === `string:${targetMonthStr}` ||
          selVal === `number:${targetMonthNumStr}` ||
          selVal === `string:${targetMonthNumStr}` ||
          selVal.endsWith(`:${targetMonthStr}`) ||
          selVal.endsWith(`:${targetMonthNumStr}`)
        ) {
          monthMatches = true;
        }
        for (const opt of selectedOptions) {
          const txt = (opt.text || opt.textContent || '').toLowerCase().trim();
          const val = (opt.value || '').trim();
          if (
            val === targetMonthStr ||
            val === targetMonthNumStr ||
            txt === targetMonthName ||
            txt.includes(targetMonthName) ||
            val.endsWith(`:${targetMonthStr}`) ||
            val.endsWith(`:${targetMonthNumStr}`) ||
            val === `string:${targetMonthStr}` ||
            val === `number:${targetMonthNumStr}` ||
            val === `string:${targetMonthNumStr}`
          ) {
            monthMatches = true;
          }
        }
      }
    }

    if (!detectedYearSelect || !detectedMonthSelect || !yearMatches || !monthMatches) {
      periodConfirmed = false;
    }
  }

  // 2.2 Confirmar pestaña activa via LI.active contenedor o hash
  let targetLiActive = false;
  let oppositeLiActive = false;

  const activeLis = Array.from(
    document.querySelectorAll('li.active, li[class*="active"], [role="tab"][aria-selected="true"], [role="tab"].active, a.active, a[class*="active"]') || []
  );

  for (const li of activeLis) {
    const childLinks = Array.from(li.querySelectorAll ? li.querySelectorAll('a, button, [role="tab"]') : []);
    const allElements = childLinks.length > 0 ? childLinks : [li];
    for (const el of allElements) {
      const href = (el.getAttribute ? el.getAttribute('href') : '') || '';
      const hrefNorm = href.trim().toLowerCase();
      const id = (el.id || (el.getAttribute ? el.getAttribute('id') : '') || '').toLowerCase();
      const txt = normalizeText(el.textContent || '');

      if (
        targetHrefPatterns.includes(hrefNorm) ||
        hrefNorm.startsWith('#' + targetWords[0]) ||
        hrefNorm.startsWith('#' + targetWords[1]) ||
        id === targetId ||
        id === `${targetId}s` ||
        targetWords.some((w) => txt === w || txt === `registro de ${w}`) ||
        (isCompras && (hrefNorm.includes('compraregistro') || hrefNorm.includes('#compra') || id.includes('registro') || txt === 'registro'))
      ) {
        targetLiActive = true;
      }

      if (
        oppositeHrefPatterns.includes(hrefNorm) ||
        hrefNorm.startsWith('#' + oppositeWords[0]) ||
        hrefNorm.startsWith('#' + oppositeWords[1]) ||
        id === (isCompras ? 'tabventa' : 'tabcompra') ||
        id === (isCompras ? 'tabventas' : 'tabcompras') ||
        oppositeWords.some((w) => txt === w || txt === `registro de ${w}`) ||
        (!isCompras && (hrefNorm.includes('compraregistro') || hrefNorm.includes('#compra') || id.includes('registro') || txt === 'registro'))
      ) {
        oppositeLiActive = true;
      }
    }
  }

  const win = typeof window !== 'undefined' ? window : null;
  const currentHash = (win && win.location && win.location.hash ? win.location.hash : '').toLowerCase();
  const hashTargetActive = targetWords.some((w) =>
    currentHash.includes(`#${w}`) || currentHash.includes(`/${w}`)
  ) || (isCompras && currentHash.includes('compraregistro'));
  const hashOppositeActive = oppositeWords.some((w) =>
    currentHash.includes(`#${w}`) || currentHash.includes(`/${w}`)
  ) || (!isCompras && currentHash.includes('compraregistro'));

  // 2.3 Circunscribir la inspección al contenedor de la pestaña ACTIVA
  const tabPanes = Array.from(
    document.querySelectorAll(
      '.tab-pane.active, [role="tabpanel"]:not([aria-hidden="true"]), .tab-content > .active'
    ) || []
  );

  let activeContainer = null;
  let isOppositePaneActive = false;
  let isTargetPaneActive = false;

  for (const pane of tabPanes) {
    const id = (pane.id || '').toLowerCase();
    const cls = (pane.className || '').toLowerCase();
    var belongsOpposite = false;
    for (var oIdx = 0; oIdx < oppositeWords.length; oIdx++) {
      var oppWord = oppositeWords[oIdx];
      if (oppWord && (id.indexOf(oppWord) !== -1 || cls.indexOf(oppWord) !== -1)) {
        belongsOpposite = true;
        break;
      }
    }
    if (belongsOpposite && isElementVisible(pane)) {
      isOppositePaneActive = true;
      continue; // Pertenece a la pestaña opuesta
    }
    var belongsTarget = false;
    for (var tIdx = 0; tIdx < targetWords.length; tIdx++) {
      var tgtWord = targetWords[tIdx];
      if (tgtWord && (id.indexOf(tgtWord) !== -1 || cls.indexOf(tgtWord) !== -1)) {
        belongsTarget = true;
        break;
      }
    }
    if (belongsTarget && isElementVisible(pane)) {
      isTargetPaneActive = true;
      activeContainer = pane;
      break;
    }
    if (!activeContainer && isElementVisible(pane)) {
      activeContainer = pane;
    }
  }

  if (!activeContainer) {
    for (var wIdx = 0; wIdx < targetWords.length; wIdx++) {
      var w = targetWords[wIdx];
      if (!w) continue;
      var byId = document.querySelector('#' + w + ', [id*="' + w + '" i], .' + w);
      if (byId && (typeof byId.matches !== 'function' || !byId.matches('a, button, li, span, [role="tab"]'))) {
        if (isElementVisible(byId)) {
          activeContainer = byId;
          isTargetPaneActive = true;
          break;
        }
      }
    }
  }

  // Determinar si hay contenido visible que corresponda al objetivo
  let targetContentVisible = false;

  if (isTargetPaneActive) {
    targetContentVisible = true;
  }

  if (!targetContentVisible) {
    for (var tw = 0; tw < targetWords.length; tw++) {
      var word = targetWords[tw];
      if (!word) continue;
      var elList = Array.from(document.querySelectorAll('#' + word + ', [id*="' + word + '" i], .' + word) || []);
      for (var eIdx = 0; eIdx < elList.length; eIdx++) {
        var elCandidate = elList[eIdx];
        if (!elCandidate) continue;
        if (typeof elCandidate.closest === 'function' && elCandidate.closest('.nav-tabs, ul.nav, [role="tablist"]')) {
          continue;
        }
        if (isElementVisible(elCandidate)) {
          targetContentVisible = true;
          break;
        }
      }
      if (targetContentVisible) break;
    }
  }

  if (!targetContentVisible) {
    var contentCandidates = Array.from(
      document.querySelectorAll('table, .table, #results-area, [ui-view], .tab-content, #compraContent, #ventaContent, #main-content, h1, h2, h3, h4, caption, legend') || []
    );
    if (activeContainer && !contentCandidates.includes(activeContainer)) {
      contentCandidates.unshift(activeContainer);
    }
    for (var cIdx = 0; cIdx < contentCandidates.length; cIdx++) {
      var cEl = contentCandidates[cIdx];
      if (!cEl) continue;
      if (isElementVisible(cEl)) {
        var cTxt = normalizeText(cEl.textContent || '');
        var hasTargetWord = false;
        for (var tWordIdx = 0; tWordIdx < targetWords.length; tWordIdx++) {
          var tgt = targetWords[tWordIdx];
          if (tgt && cTxt.indexOf(tgt) !== -1) {
            hasTargetWord = true;
            break;
          }
        }
        if (isCompras && !hasTargetWord && (cTxt.indexOf('registro') !== -1 || cTxt.indexOf('compraregistro') !== -1)) {
          hasTargetWord = true;
        }
        var hasOppositeWord = false;
        for (var oWordIdx = 0; oWordIdx < oppositeWords.length; oWordIdx++) {
          var opp = oppositeWords[oWordIdx];
          if (opp && cTxt.indexOf(opp) !== -1) {
            hasOppositeWord = true;
            break;
          }
        }
        if (hasTargetWord && !hasOppositeWord) {
          targetContentVisible = true;
          break;
        }
      }
    }
  }

  if (!targetContentVisible && isCompras) {
    var compraLinks = Array.from(document.querySelectorAll('a[href*="compra" i], [id*="registro" i]') || []);
    for (var clIdx = 0; clIdx < compraLinks.length; clIdx++) {
      var cLink = compraLinks[clIdx];
      if (!cLink) continue;
      if (typeof cLink.closest === 'function' && cLink.closest('.nav-tabs, ul.nav-tabs')) {
        continue;
      }
      if (isElementVisible(cLink)) {
        var cHref = (cLink.getAttribute ? cLink.getAttribute('href') : '') || '';
        var clTxt = normalizeText(cLink.textContent || '');
        if (cHref.toLowerCase().indexOf('compraregistro') !== -1 || clTxt === 'registro') {
          targetContentVisible = true;
          break;
        }
      }
    }
  }

  if (!targetContentVisible && !isCompras) {
    var ventaButtons = Array.from(document.querySelectorAll('button, a') || []);
    for (var vbIdx = 0; vbIdx < ventaButtons.length; vbIdx++) {
      var vBtn = ventaButtons[vbIdx];
      if (!vBtn) continue;
      if (isElementVisible(vBtn)) {
        var vbTxt = normalizeText(vBtn.textContent || '');
        if (vbTxt.indexOf('boleta') !== -1 || vbTxt.indexOf('boletas') !== -1) {
          targetContentVisible = true;
          break;
        }
      }
    }
  }

  // Helper para detectar subpestañas excluidas
  // @ts-expect-error browser runtime helper parameter
  var isForbiddenSubtabItem = (0, function(el) {
    var rawT = (el.textContent || el.value || '');
    var normT = normalizeText(rawT);
    var h = (el.getAttribute ? el.getAttribute('href') : '') || '';
    var hNorm = h.trim().toLowerCase();
    var elId = (el.id || (el.getAttribute ? el.getAttribute('id') : '') || '').toLowerCase();

    if (
      normT.indexOf('observad') !== -1 ||
      normT.indexOf('diferid') !== -1 ||
      normT.indexOf('boleta') !== -1 ||
      normT.indexOf('resumen') !== -1 ||
      hNorm.indexOf('observad') !== -1 ||
      hNorm.indexOf('diferid') !== -1 ||
      hNorm.indexOf('boleta') !== -1 ||
      elId.indexOf('observad') !== -1 ||
      elId.indexOf('diferid') !== -1
    ) {
      return true;
    }

    if (
      normT === 'pendientes' ||
      normT.indexOf('pendiente') !== -1 ||
      normT === 'no incluir' ||
      normT.indexOf('no incluir') !== -1 ||
      normT === 'reclamados' ||
      normT.indexOf('reclamado') !== -1 ||
      hNorm.indexOf('pendiente') !== -1 ||
      hNorm.indexOf('noincluir') !== -1 ||
      hNorm.indexOf('no-incluir') !== -1 ||
      hNorm.indexOf('reclamado') !== -1 ||
      elId.indexOf('pendiente') !== -1 ||
      elId.indexOf('noincluir') !== -1 ||
      elId.indexOf('no-incluir') !== -1 ||
      elId.indexOf('reclamado') !== -1
    ) {
      return true;
    }

    return false;
  });

  var subtabRegistroFound = false;
  var subtabRegistroActive = false;

  var subtabCandidates = Array.from(
    document.querySelectorAll('a, button, [role="tab"], li, span') || []
  );

  var subtabRegEl = null;
  for (var scI = 0; scI < subtabCandidates.length; scI++) {
    var scCand = subtabCandidates[scI];
    if (!scCand || isForbiddenSubtabItem(scCand)) continue;
    var scId = (scCand.id || (scCand.getAttribute ? scCand.getAttribute('id') : '') || '').toLowerCase();
    var scH = (scCand.getAttribute ? scCand.getAttribute('href') : '') || '';
    var scHNorm = scH.trim().toLowerCase();

    if (
      scId === 'tabregistro' ||
      scId === 'subtab-registro' ||
      scId === 'subtabregistro' ||
      scHNorm === '#registro' ||
      scHNorm === '#registro/' ||
      scHNorm === '#/compra/registro' ||
      scHNorm.slice(-9) === '/registro' ||
      scHNorm.slice(-10) === '/registro/' ||
      scHNorm.indexOf('compraregistro') !== -1 ||
      scHNorm === '#compraregistro/' ||
      scHNorm === '#compraregistro'
    ) {
      subtabRegEl = scCand;
      break;
    }
  }

  if (!subtabRegEl) {
    for (var scI2 = 0; scI2 < subtabCandidates.length; scI2++) {
      var scCand2 = subtabCandidates[scI2];
      if (!scCand2 || isForbiddenSubtabItem(scCand2)) continue;
      var scTxt2 = normalizeText(scCand2.textContent || scCand2.value || '');
      if (scTxt2 === 'registro') {
        var aSub = scCand2.querySelector ? scCand2.querySelector('a') : null;
        subtabRegEl = aSub || scCand2;
        break;
      }
    }
  }

  if (subtabRegEl) {
    subtabRegistroFound = true;
    var pLi = subtabRegEl.closest ? subtabRegEl.closest('li') : null;
    var liAct = Boolean(
      pLi &&
      ((pLi.classList && pLi.classList.contains('active')) || (pLi.getAttribute && pLi.getAttribute('aria-selected') === 'true'))
    );
    var selfAct = Boolean(
      (subtabRegEl.classList && subtabRegEl.classList.contains('active')) ||
      (subtabRegEl.getAttribute && subtabRegEl.getAttribute('aria-selected') === 'true')
    );
    var hashStr = (win && win.location && win.location.hash ? win.location.hash : '').toLowerCase();
    var hashAct = hashStr.indexOf('compraregistro') !== -1;
    var isSubtabVis = isElementVisible(subtabRegEl);
    subtabRegistroActive = Boolean((liAct || selfAct || hashAct) && isSubtabVis);
  } else if (isCompras) {
    var compHashStr = (win && win.location && win.location.hash ? win.location.hash : '').toLowerCase();
    if (compHashStr.indexOf('compraregistro') !== -1) {
      subtabRegistroActive = true;
    }
  }

  // Detección de si se observan subpestañas de compra en el DOM (Registro, Pendientes, No Incluir, Reclamados)
  // En el portal del SII, estas subpestañas existen EXCLUSIVAMENTE en COMPRA y NUNCA en VENTA.
  var hasComprasSubtabsObserved = false;
  if (!isCompras) {
    if (subtabRegistroActive || (subtabRegistroFound && isElementVisible(subtabRegEl))) {
      hasComprasSubtabsObserved = true;
    }
    if (!hasComprasSubtabsObserved) {
      for (var scIdx = 0; scIdx < subtabCandidates.length; scIdx++) {
        var cand = subtabCandidates[scIdx];
        if (!cand) continue;
        var candTxt = normalizeText(cand.textContent || cand.value || '');
        var candHref = ((cand.getAttribute ? cand.getAttribute('href') : '') || '').toLowerCase();
        var candId = (cand.id || (cand.getAttribute ? cand.getAttribute('id') : '') || '').toLowerCase();

        var isCompraSubtabName =
          candTxt === 'pendientes' ||
          candTxt === 'no incluir' ||
          candTxt === 'reclamados' ||
          candHref.indexOf('pendiente') !== -1 ||
          candHref.indexOf('noincluir') !== -1 ||
          candHref.indexOf('reclamado') !== -1 ||
          candId.indexOf('pendiente') !== -1 ||
          candId.indexOf('noincluir') !== -1 ||
          candId.indexOf('reclamado') !== -1;

        if (isCompraSubtabName) {
          var candParentLi = cand.closest ? cand.closest('li') : null;
          var isCandAct = Boolean(
            (candParentLi && ((candParentLi.classList && candParentLi.classList.contains('active')) || (candParentLi.getAttribute && candParentLi.getAttribute('aria-selected') === 'true'))) ||
            (cand.classList && cand.classList.contains('active')) ||
            (cand.getAttribute && cand.getAttribute('aria-selected') === 'true')
          );
          if (isCandAct || isElementVisible(cand)) {
            hasComprasSubtabsObserved = true;
            break;
          }
        }
      }
    }
  }

  // Evidencia positiva de que la pestaña ACTIVA es la opuesta
  var hasOppositeActiveEvidence = Boolean(
    (oppositeLiActive && !targetLiActive) ||
    (hashOppositeActive && !hashTargetActive) ||
    (isOppositePaneActive && !isTargetPaneActive) ||
    (!isCompras && hasComprasSubtabsObserved)
  );

  let activeTabConfirmed = false;
  if (!hasOppositeActiveEvidence) {
    if (targetLiActive) {
      // (a) Hay li.active que contiene la pestaña objetivo
      activeTabConfirmed = true;
    } else if (hashTargetActive) {
      // (b) El hash corresponde a la pestaña objetivo
      activeTabConfirmed = true;
    } else if (targetContentVisible) {
      // (c) NO hay ninguna marca de pestaña opuesta activa y el contenido visible corresponde al objetivo
      activeTabConfirmed = true;
    }
  }

  // Regla de seguridad estricta para VENTA:
  // Si se observan subpestañas de compra mientras el objetivo es ventas, activeTabConfirmed NUNCA puede ser true.
  if (!isCompras && hasComprasSubtabsObserved) {
    activeTabConfirmed = false;
  }

  let activeText = '';
  if (activeContainer) {
    activeText = (activeContainer.innerText || activeContainer.textContent || '').toLowerCase();
  }

  // Complementar con el texto del contenedor principal o cuerpo si el contenido se renderiza fuera de .tab-pane.active
  // (evidencia real en COMPRA donde el contenido/tablas/mensajes se renderizan fuera de .tab-pane.active),
  // excluyendo estrictamente paneles y elementos pertenecientes a la pestaña opuesta o subpestañas excluidas.
  const mainRoot =
    document.querySelector('#consdcv, #rcvApp, #app, [ui-view], .consdcv, #main-content') ||
    document.body ||
    null;

  if (mainRoot) {
    const oppositeSelectors = [];
    for (const opp of oppositeWords) {
      oppositeSelectors.push('#' + opp);
      oppositeSelectors.push('#tab' + opp);
      oppositeSelectors.push('#tab-' + opp);
      oppositeSelectors.push('#pane-' + opp);
      oppositeSelectors.push('[id^="' + opp + '-" i]');
      oppositeSelectors.push('[id^="' + opp + '_" i]');
      oppositeSelectors.push('.' + opp);
    }
    oppositeSelectors.push('#pendientes, #reclamados, #noincluir, #no-incluir, #tab-pendientes, #tab-reclamados, #tab-noincluir, #tab-no-incluir');
    oppositeSelectors.push('[role="tabpanel"][aria-hidden="true"], [hidden], .ng-hide');

    const rawOppositePanes = mainRoot.querySelectorAll
      ? Array.from(mainRoot.querySelectorAll(oppositeSelectors.join(', ')))
      : [];

    const oppositePanes = rawOppositePanes.filter(function(el) {
      var elId = (el.id || (el.getAttribute ? el.getAttribute('id') : '') || '').toLowerCase();
      if (elId.indexOf('compra') !== -1 && elId.indexOf('venta') !== -1) {
        return false;
      }
      if (isElementVisible(el)) {
        var isRealOpp = false;
        for (var o = 0; o < oppositeWords.length; o++) {
          var ow = oppositeWords[o];
          if (ow && (elId === ow || elId.indexOf(ow) === 0 || elId.indexOf('-' + ow) !== -1 || elId.indexOf('_' + ow) !== -1)) {
            isRealOpp = true;
            break;
          }
        }
        if (!isRealOpp) {
          return false;
        }
      }
      return true;
    });

    const oppositeTexts = oppositePanes.map(function(el) {
      return (el.innerText || el.textContent || '').toLowerCase();
    });

    let filtered = (mainRoot.innerText || mainRoot.textContent || '').toLowerCase();
    for (const oppTxt of oppositeTexts) {
      if (oppTxt.trim().length > 0) {
        filtered = filtered.replace(oppTxt, '');
      }
    }
    activeText = (activeText + ' ' + filtered).trim();
  }

  const normActiveText = normalizeText(activeText);

  // Textos reales observados en el portal del SII en períodos sin movimiento (ej. 'No hay información de Registro.', 'No hay información de Ventas.')
  const noMovementsPatterns = [
    'no hay informacion de registro',
    'no hay informacion de ventas',
    'no hay informacion de compras',
    'no hay informacion de',
    'no se encontraron registros',
    'no existen registros',
    'sin movimientos',
    'no se registran documentos',
    'sin información para el periodo',
    'sin informacion para el periodo',
    'no existen documentos registrados',
    'no hay documentos para mostrar',
    'sin registros para el periodo',
    'sin registros para el período',
    'no registra documentos',
  ];

  const patternMatched = noMovementsPatterns.some(function(pattern) {
    return normActiveText.indexOf(pattern) !== -1 || activeText.indexOf(pattern) !== -1;
  });

  // Fallback: 'no hay informacion' solo si el área inspeccionada es la activa y el período está confirmado
  const hasFallbackNoMovements = Boolean(
    !patternMatched &&
    periodConfirmed &&
    activeTabConfirmed &&
    (normActiveText.indexOf('no hay informacion') !== -1 || activeText.indexOf('no hay informacion') !== -1)
  );

  const isNoMovementsDetected = Boolean(patternMatched || hasFallbackNoMovements);
  const hasNoMovements = Boolean(isNoMovementsDetected && periodConfirmed && activeTabConfirmed);

  // @ts-expect-error browser runtime helper parameter
  const getButtonNormalizedText = (0, function(b) {
    if (!b) return '';
    var sources = [
      b.textContent,
      typeof b.innerText === 'string' ? b.innerText : '',
      typeof b.value === 'string' ? b.value : (b.getAttribute ? b.getAttribute('value') : ''),
      (b.getAttribute ? b.getAttribute('title') : '') || b.title || '',
      (b.getAttribute ? b.getAttribute('aria-label') : '') || ''
    ];
    var parts = [];
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      if (s && typeof s === 'string') {
        var n = normalizeText(s);
        if (n && parts.indexOf(n) === -1) {
          parts.push(n);
        }
      }
    }
    return parts.join(' ');
  });

  // @ts-expect-error browser runtime helper parameter
  const isDownloadDetalleText = (0, function(norm) {
    if (!norm) return false;
    if (
      norm.indexOf('resumen') !== -1 ||
      norm.indexOf('boleta') !== -1 ||
      norm.indexOf('pendiente') !== -1 ||
      norm.indexOf('no incluir') !== -1 ||
      norm.indexOf('reclamado') !== -1
    ) {
      return false;
    }
    return norm.indexOf('descargar detalle') !== -1;
  });

  // Helper preciso y conservador para detectar si un botón pertenece a la pestaña opuesta
  // Excluye SOLO si está dentro de un contenedor cuyo id o href normalizado corresponda
  // inequívocamente a la pestaña opuesta y ADEMÁS ese contenedor está realmente oculto.
  // @ts-expect-error browser runtime helper parameter
  const isOppositeHidden = (0, function(b, oppWords) {
    if (!b || !b.parentElement || !oppWords || oppWords.length === 0) return false;
    var win = b.ownerDocument ? b.ownerDocument.defaultView : (typeof window !== 'undefined' ? window : null);
    var docElem = b.ownerDocument ? b.ownerDocument.documentElement : null;
    var curr = b.parentElement;

    while (curr && curr !== docElem) {
      var id = (curr.id || (curr.getAttribute ? curr.getAttribute('id') : '') || '').trim().toLowerCase();
      var href = (curr.getAttribute ? curr.getAttribute('href') : '') || '';
      var hrefNorm = href.trim().toLowerCase();

      var hasBoth = id.indexOf('compra') !== -1 && id.indexOf('venta') !== -1;
      if (hasBoth) {
        curr = curr.parentElement;
        continue;
      }

      var isOpp = false;
      for (var i = 0; i < oppWords.length; i++) {
        var w = oppWords[i];
        if (!w) continue;
        if (
          id === w ||
          id === 'tab' + w ||
          id === 'tab-' + w ||
          id === 'pane-' + w ||
          id.indexOf(w + '-') === 0 ||
          id.indexOf(w + '_') === 0 ||
          id.indexOf(w) === 0 ||
          hrefNorm === '#' + w ||
          hrefNorm === '#/' + w ||
          hrefNorm === '#' + w + '/' ||
          hrefNorm.indexOf('#' + w + '/') === 0 ||
          hrefNorm.indexOf('#/' + w + '/') === 0
        ) {
          isOpp = true;
          break;
        }
      }

      if (isOpp) {
        // Encontrado contenedor inequívoco de la pestaña opuesta.
        // Verificar si está realmente oculto (display:none/visibility:hidden/hidden/aria-hidden o tab-pane inactivo)
        var checkEl = curr;
        var isHidden = false;
        while (checkEl && checkEl !== docElem) {
          if (checkEl.hidden || (checkEl.getAttribute && (checkEl.getAttribute('hidden') !== null || checkEl.getAttribute('aria-hidden') === 'true'))) {
            isHidden = true;
            break;
          }
          var s = checkEl.style;
          if (s && (s.display === 'none' || s.visibility === 'hidden')) {
            isHidden = true;
            break;
          }
          if (win && typeof win.getComputedStyle === 'function') {
            try {
              var comp = win.getComputedStyle(checkEl);
              if (comp && (comp.display === 'none' || comp.visibility === 'hidden')) {
                isHidden = true;
                break;
              }
            } catch {
              // safe
            }
          }
          checkEl = checkEl.parentElement;
        }

        if (
          !isHidden &&
          curr.classList &&
          curr.classList.contains('tab-pane') &&
          !curr.classList.contains('active')
        ) {
          var parentContent = curr.closest ? curr.closest('.tab-content') : null;
          if (parentContent && parentContent.querySelector && parentContent.querySelector('.tab-pane.active')) {
            isHidden = true;
          }
        }

        if (isHidden) {
          return true;
        }
      }

      curr = curr.parentElement;
    }

    return false;
  });

  // Helper preciso para identificar si un botón se encuentra dentro de un panel/tab-pane ancestro realmente oculto.
  // Criterio basado EXCLUSIVAMENTE en visibilidad efectiva y pertenencia real:
  // Excluye un botón SOLO si el panel/tab-pane ancestro más cercano está REALMENTE OCULTO
  // (display:none, visibility:hidden, hidden, aria-hidden=true, o rect 0x0).
  // Si el panel ancestro está visible, NO excluir aunque su id sea 'pendiente', 'reclamados', etc.
  // @ts-expect-error browser runtime helper parameter
  const isAncestorPanelHidden = (0, function(b) {
    if (!b || !b.parentElement) return false;
    var win = b.ownerDocument ? b.ownerDocument.defaultView : (typeof window !== 'undefined' ? window : null);
    var docElem = b.ownerDocument ? b.ownerDocument.documentElement : null;
    var isJsdom = Boolean(win && win.navigator && win.navigator.userAgent && win.navigator.userAgent.indexOf('jsdom') !== -1);

    var curr = b.parentElement;
    var closestPanel = null;

    // Buscar el panel/tab-pane ancestro más cercano
    while (curr && curr !== docElem) {
      var isTabPane = Boolean(
        (curr.classList && (curr.classList.contains('tab-pane') || curr.classList.contains('tabpanel'))) ||
        (curr.getAttribute && curr.getAttribute('role') === 'tabpanel')
      );
      var cId = (curr.id || (curr.getAttribute ? curr.getAttribute('id') : '') || '').trim().toLowerCase();
      var isIdPanel = Boolean(
        cId === 'pendiente' || cId === 'pendientes' ||
        cId === 'reclamado' || cId === 'reclamados' ||
        cId === 'noincluir' || cId === 'no-incluir' || cId === 'no_incluir' ||
        cId === 'registro' || cId === 'home' ||
        cId.indexOf('tab-') === 0 || cId.indexOf('tab_') === 0 ||
        cId.indexOf('pane-') === 0 || cId.indexOf('pane_') === 0 ||
        cId.indexOf('subtab-') === 0 || cId.indexOf('subtab_') === 0
      );

      if (isTabPane || isIdPanel) {
        closestPanel = curr;
        break;
      }

      curr = curr.parentElement;
    }

    if (!closestPanel) {
      return false;
    }

    // Evaluar si el panel ancestro más cercano está REALMENTE OCULTO
    // (display:none, visibility:hidden, hidden, aria-hidden=true, o rect 0x0)
    if (closestPanel.hidden) return true;
    if (closestPanel.getAttribute && (closestPanel.getAttribute('hidden') !== null || closestPanel.getAttribute('aria-hidden') === 'true')) {
      return true;
    }

    var s = closestPanel.style;
    if (s && (s.display === 'none' || s.visibility === 'hidden')) {
      return true;
    }
    if (win && typeof win.getComputedStyle === 'function') {
      try {
        var comp = win.getComputedStyle(closestPanel);
        if (comp && (comp.display === 'none' || comp.visibility === 'hidden')) {
          return true;
        }
      } catch {
        // safe
      }
    }

    var pCurr = closestPanel.parentElement;
    while (pCurr && pCurr !== docElem) {
      if (pCurr.hidden) return true;
      if (pCurr.getAttribute && (pCurr.getAttribute('hidden') !== null || pCurr.getAttribute('aria-hidden') === 'true')) {
        return true;
      }
      var ps = pCurr.style;
      if (ps && (ps.display === 'none' || ps.visibility === 'hidden')) {
        return true;
      }
      if (win && typeof win.getComputedStyle === 'function') {
        try {
          var pcomp = win.getComputedStyle(pCurr);
          if (pcomp && (pcomp.display === 'none' || pcomp.visibility === 'hidden')) {
            return true;
          }
        } catch {
          // safe
        }
      }
      pCurr = pCurr.parentElement;
    }

    if (!isJsdom) {
      var rect = typeof closestPanel.getBoundingClientRect === 'function' ? closestPanel.getBoundingClientRect() : null;
      var hasGeometry = closestPanel.offsetParent !== null || Boolean(rect && (rect.width > 0 || rect.height > 0));
      if (!hasGeometry) {
        return true;
      }
    }

    return false;
  });

  const isInForbiddenSubtabPanel = isAncestorPanelHidden;

  // Helper estricto para botón "Descargar Detalles" (NUNCA Resumenes ni Boletas)
  // @ts-expect-error browser runtime helper parameter
  const isCandidateDownloadButton = (0, function(b) {
    var norm = getButtonNormalizedText(b);

    if (!isDownloadDetalleText(norm)) {
      return false;
    }

    // Excluir si pertenece a subpestañas excluidas
    if (isInForbiddenSubtabPanel(b)) {
      return false;
    }

    // Exclusión de botones que estén dentro del contenedor de la pestaña OPUESTA solo si ese contenedor está realmente oculto
    if (isOppositeHidden(b, oppositeWords)) {
      return false;
    }

    // (c) Excluir candidatos dentro de paneles ocultos reales comprobando visibilidad efectiva
    if (!isElementVisible(b)) {
      return false;
    }

    return true;
  });

  // Búsqueda en la totalidad del documento (document.querySelectorAll) sin restringir a activePane
  const allButtons = Array.from(
    document.querySelectorAll('button, a, input[type="button"], [role="button"]') || []
  );

  let downloadButtonsFound = 0;
  const downloadButtonLabels = [];
  let detalleButtonFound = false;
  let detalleButtonVisible = false;
  let detalleRejectedBySubtabFilter = false;
  let detalleRejectedByOppositeContainer = false;
  let detalleRejectedByVisibility = false;

  let downloadBtn = null;

  for (let bIdx = 0; bIdx < allButtons.length; bIdx++) {
    const bCand = allButtons[bIdx];
    if (!bCand) continue;
    const bNorm = getButtonNormalizedText(bCand);

    const isDownload = bNorm.indexOf('descargar') === 0;
    const hasDetalleText = bNorm.indexOf('descargar detalle') !== -1;
    const isDetalle = isDownloadDetalleText(bNorm);

    if (!isDownload && !hasDetalleText) {
      continue;
    }

    // 1. Detección y exclusión por subpestañas (pendientes, no incluir, reclamados)
    const inForbiddenSubtab = isInForbiddenSubtabPanel(bCand);

    const isSubtabSpecificDetalle =
      hasDetalleText &&
      (inForbiddenSubtab ||
        bNorm.indexOf('pendiente') !== -1 ||
        bNorm.indexOf('no incluir') !== -1 ||
        bNorm.indexOf('reclamado') !== -1);

    if (inForbiddenSubtab || isSubtabSpecificDetalle) {
      if (hasDetalleText) {
        detalleRejectedBySubtabFilter = true;
      }
      continue;
    }

    // 2. Detección y exclusión por contenedor de la pestaña opuesta realmente oculto
    if (isOppositeHidden(bCand, oppositeWords)) {
      if (isDetalle) {
        detalleRejectedByOppositeContainer = true;
      }
      continue;
    }

    // 3. Conjunto unificado de candidatos válidos en la pestaña activa:
    // Alimenta coherente y simultáneamente downloadButtonLabels, downloadButtonsFound y detalleButtonFound
    if (isDownload) {
      downloadButtonsFound++;
      if (downloadButtonLabels.length < 5) {
        downloadButtonLabels.push(bNorm.slice(0, 40));
      }
    }

    if (isDetalle) {
      detalleButtonFound = true;
      if (isElementVisible(bCand)) {
        detalleButtonVisible = true;
        if (!downloadBtn) {
          downloadBtn = bCand;
        }
      } else {
        detalleRejectedByVisibility = true;
      }
    }
  }

  if (!downloadBtn) {
    downloadBtn = allButtons.find(isCandidateDownloadButton) || null;
  }
  const tableCount = Array.from(document.querySelectorAll('table') || []).length;
  const noMovementsPatternFound = Boolean(isNoMovementsDetected);

  const rawHashVal = (win && win.location && win.location.hash ? win.location.hash : '');
  let hashEndsWith = '';
  if (rawHashVal) {
    const hashWithoutQuery = rawHashVal.split('?')[0] ?? '';
    const cleanH = (hashWithoutQuery.split('&')[0] ?? '').trim();
    const hMatch = cleanH.match(/^#[a-zA-Z0-9_\-/]+/);
    hashEndsWith = hMatch ? (hMatch[0] ?? '') : '';
  }

  return {
    hasNoMovements,
    hasDownloadButton: Boolean(downloadBtn && activeTabConfirmed && periodConfirmed),
    periodConfirmed,
    activeTabConfirmed,
    subtabRegistroFound,
    subtabRegistroActive,
    downloadButtonsFound,
    detalleButtonFound,
    detalleButtonVisible,
    tableCount,
    noMovementsPatternFound,
    hashEndsWith,
    downloadButtonLabels,
    detalleRejectedByOppositeContainer: Boolean(detalleRejectedByOppositeContainer && !detalleButtonFound),
    detalleRejectedByVisibility: Boolean(detalleRejectedByVisibility && !detalleButtonVisible),
    detalleRejectedBySubtabFilter: Boolean(detalleRejectedBySubtabFilter && !detalleButtonFound),
  };
}

/**
 * Activa el botón de descarga de detalles CSV en el DOM.
 * Ejecutada en el navegador como JS puro serializable.
 */
export function evaluateClickDownloadCsv(): boolean {
  // @ts-expect-error browser runtime helper parameter
  const normalizeText = (0, function(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .replace(/[\u00a0\s]+/g, ' ')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[\u00a0\s]+/g, ' ')
      .trim();
  });

  // Detectar palabras de la pestaña opuesta si se puede inferir del estado activo
  let oppositeWords = ['', ''].filter(Boolean);
  const activeLi = document.querySelector('li.active, li[class*="active"], [role="tab"][aria-selected="true"]');
  if (activeLi) {
    const txt = normalizeText(activeLi.textContent || '');
    const aChild = activeLi.querySelector ? activeLi.querySelector('a') : null;
    const href = (aChild && aChild.getAttribute ? (aChild.getAttribute('href') || '') : '').toLowerCase();
    if (txt.indexOf('compra') !== -1 || href.indexOf('compra') !== -1 || txt === 'registro') {
      oppositeWords = ['venta', 'ventas'];
    } else if (txt.indexOf('venta') !== -1 || href.indexOf('venta') !== -1) {
      oppositeWords = ['compra', 'compras'];
    }
  }
  if (oppositeWords.length === 0 && typeof window !== 'undefined') {
    const hash = (window.location?.hash || '').toLowerCase();
    if (hash.indexOf('compra') !== -1) {
      oppositeWords = ['venta', 'ventas'];
    } else if (hash.indexOf('venta') !== -1) {
      oppositeWords = ['compra', 'compras'];
    }
  }

  // Helper de visibilidad efectiva basado exclusivamente en el estado real de renderizado
  // @ts-expect-error browser runtime helper parameter
  const isElementVisible = (0, function(el) {
    if (!el) return false;
    if (el.hidden) return false;
    if (el.getAttribute && (el.getAttribute('hidden') !== null || el.getAttribute('aria-hidden') === 'true')) {
      return false;
    }

    const win = el.ownerDocument ? el.ownerDocument.defaultView : (typeof window !== 'undefined' ? window : null);
    const isJsdom = Boolean(win && win.navigator && win.navigator.userAgent && win.navigator.userAgent.indexOf('jsdom') !== -1);

    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    const hasGeometry = el.offsetParent !== null || Boolean(rect && (rect.width > 0 || rect.height > 0));
    if (!hasGeometry && !isJsdom) {
      return false;
    }

    let curr = el;
    const docElem = el.ownerDocument ? el.ownerDocument.documentElement : null;
    while (curr && curr !== docElem) {
      if (curr.hidden) return false;
      if (curr.getAttribute && (curr.getAttribute('hidden') !== null || curr.getAttribute('aria-hidden') === 'true')) {
        return false;
      }
      const s = curr.style;
      if (s && (s.display === 'none' || s.visibility === 'hidden')) {
        return false;
      }
      if (win && typeof win.getComputedStyle === 'function') {
        try {
          const comp = win.getComputedStyle(curr);
          if (comp && (comp.display === 'none' || comp.visibility === 'hidden')) {
            return false;
          }
        } catch {
          // safe
        }
      }
      curr = curr.parentElement;
    }

    return true;
  });

  // Helper preciso y conservador para detectar si un botón pertenece a la pestaña opuesta
  // Excluye SOLO si está dentro de un contenedor cuyo id o href normalizado corresponda
  // inequívocamente a la pestaña opuesta y ADEMÁS ese contenedor está realmente oculto.
  // @ts-expect-error browser runtime helper parameter
  const isOppositeHidden = (0, function(b, oppWords) {
    if (!b || !b.parentElement || !oppWords || oppWords.length === 0) return false;
    var win = b.ownerDocument ? b.ownerDocument.defaultView : (typeof window !== 'undefined' ? window : null);
    var docElem = b.ownerDocument ? b.ownerDocument.documentElement : null;
    var curr = b.parentElement;

    while (curr && curr !== docElem) {
      var id = (curr.id || (curr.getAttribute ? curr.getAttribute('id') : '') || '').trim().toLowerCase();
      var href = (curr.getAttribute ? curr.getAttribute('href') : '') || '';
      var hrefNorm = href.trim().toLowerCase();

      var hasBoth = id.indexOf('compra') !== -1 && id.indexOf('venta') !== -1;
      if (hasBoth) {
        curr = curr.parentElement;
        continue;
      }

      var isOpp = false;
      for (var i = 0; i < oppWords.length; i++) {
        var w = oppWords[i];
        if (!w) continue;
        if (
          id === w ||
          id === 'tab' + w ||
          id === 'tab-' + w ||
          id === 'pane-' + w ||
          id.indexOf(w + '-') === 0 ||
          id.indexOf(w + '_') === 0 ||
          id.indexOf(w) === 0 ||
          hrefNorm === '#' + w ||
          hrefNorm === '#/' + w ||
          hrefNorm === '#' + w + '/' ||
          hrefNorm.indexOf('#' + w + '/') === 0 ||
          hrefNorm.indexOf('#/' + w + '/') === 0
        ) {
          isOpp = true;
          break;
        }
      }

      if (isOpp) {
        // Encontrado contenedor inequívoco de la pestaña opuesta.
        // Verificar si está realmente oculto (display:none/visibility:hidden/hidden/aria-hidden o tab-pane inactivo)
        var checkEl = curr;
        var isHidden = false;
        while (checkEl && checkEl !== docElem) {
          if (checkEl.hidden || (checkEl.getAttribute && (checkEl.getAttribute('hidden') !== null || checkEl.getAttribute('aria-hidden') === 'true'))) {
            isHidden = true;
            break;
          }
          var s = checkEl.style;
          if (s && (s.display === 'none' || s.visibility === 'hidden')) {
            isHidden = true;
            break;
          }
          if (win && typeof win.getComputedStyle === 'function') {
            try {
              var comp = win.getComputedStyle(checkEl);
              if (comp && (comp.display === 'none' || comp.visibility === 'hidden')) {
                isHidden = true;
                break;
              }
            } catch {
              // safe
            }
          }
          checkEl = checkEl.parentElement;
        }

        if (
          !isHidden &&
          curr.classList &&
          curr.classList.contains('tab-pane') &&
          !curr.classList.contains('active')
        ) {
          var parentContent = curr.closest ? curr.closest('.tab-content') : null;
          if (parentContent && parentContent.querySelector && parentContent.querySelector('.tab-pane.active')) {
            isHidden = true;
          }
        }

        if (isHidden) {
          return true;
        }
      }

      curr = curr.parentElement;
    }

    return false;
  });

  // @ts-expect-error browser runtime helper parameter
  const getButtonNormalizedText = (0, function(b) {
    if (!b) return '';
    var sources = [
      b.textContent,
      typeof b.innerText === 'string' ? b.innerText : '',
      typeof b.value === 'string' ? b.value : (b.getAttribute ? b.getAttribute('value') : ''),
      (b.getAttribute ? b.getAttribute('title') : '') || b.title || '',
      (b.getAttribute ? b.getAttribute('aria-label') : '') || ''
    ];
    var parts = [];
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      if (s && typeof s === 'string') {
        var n = normalizeText(s);
        if (n && parts.indexOf(n) === -1) {
          parts.push(n);
        }
      }
    }
    return parts.join(' ');
  });

  // @ts-expect-error browser runtime helper parameter
  const isDownloadDetalleText = (0, function(norm) {
    if (!norm) return false;
    if (
      norm.indexOf('resumen') !== -1 ||
      norm.indexOf('boleta') !== -1 ||
      norm.indexOf('pendiente') !== -1 ||
      norm.indexOf('no incluir') !== -1 ||
      norm.indexOf('reclamado') !== -1
    ) {
      return false;
    }
    return norm.indexOf('descargar detalle') !== -1;
  });

  // Helper preciso para identificar si un botón se encuentra dentro de un panel/tab-pane ancestro realmente oculto.
  // Criterio basado EXCLUSIVAMENTE en visibilidad efectiva y pertenencia real:
  // Excluye un botón SOLO si el panel/tab-pane ancestro más cercano está REALMENTE OCULTO
  // (display:none, visibility:hidden, hidden, aria-hidden=true, o rect 0x0).
  // Si el panel ancestro está visible, NO excluir aunque su id sea 'pendiente', 'reclamados', etc.
  // @ts-expect-error browser runtime helper parameter
  const isAncestorPanelHidden = (0, function(b) {
    if (!b || !b.parentElement) return false;
    var win = b.ownerDocument ? b.ownerDocument.defaultView : (typeof window !== 'undefined' ? window : null);
    var docElem = b.ownerDocument ? b.ownerDocument.documentElement : null;
    var isJsdom = Boolean(win && win.navigator && win.navigator.userAgent && win.navigator.userAgent.indexOf('jsdom') !== -1);

    var curr = b.parentElement;
    var closestPanel = null;

    // Buscar el panel/tab-pane ancestro más cercano
    while (curr && curr !== docElem) {
      var isTabPane = Boolean(
        (curr.classList && (curr.classList.contains('tab-pane') || curr.classList.contains('tabpanel'))) ||
        (curr.getAttribute && curr.getAttribute('role') === 'tabpanel')
      );
      var cId = (curr.id || (curr.getAttribute ? curr.getAttribute('id') : '') || '').trim().toLowerCase();
      var isIdPanel = Boolean(
        cId === 'pendiente' || cId === 'pendientes' ||
        cId === 'reclamado' || cId === 'reclamados' ||
        cId === 'noincluir' || cId === 'no-incluir' || cId === 'no_incluir' ||
        cId === 'registro' || cId === 'home' ||
        cId.indexOf('tab-') === 0 || cId.indexOf('tab_') === 0 ||
        cId.indexOf('pane-') === 0 || cId.indexOf('pane_') === 0 ||
        cId.indexOf('subtab-') === 0 || cId.indexOf('subtab_') === 0
      );

      if (isTabPane || isIdPanel) {
        closestPanel = curr;
        break;
      }

      curr = curr.parentElement;
    }

    if (!closestPanel) {
      return false;
    }

    // Evaluar si el panel ancestro más cercano está REALMENTE OCULTO
    // (display:none, visibility:hidden, hidden, aria-hidden=true, o rect 0x0)
    if (closestPanel.hidden) return true;
    if (closestPanel.getAttribute && (closestPanel.getAttribute('hidden') !== null || closestPanel.getAttribute('aria-hidden') === 'true')) {
      return true;
    }

    var s = closestPanel.style;
    if (s && (s.display === 'none' || s.visibility === 'hidden')) {
      return true;
    }
    if (win && typeof win.getComputedStyle === 'function') {
      try {
        var comp = win.getComputedStyle(closestPanel);
        if (comp && (comp.display === 'none' || comp.visibility === 'hidden')) {
          return true;
        }
      } catch {
        // safe
      }
    }

    var pCurr = closestPanel.parentElement;
    while (pCurr && pCurr !== docElem) {
      if (pCurr.hidden) return true;
      if (pCurr.getAttribute && (pCurr.getAttribute('hidden') !== null || pCurr.getAttribute('aria-hidden') === 'true')) {
        return true;
      }
      var ps = pCurr.style;
      if (ps && (ps.display === 'none' || ps.visibility === 'hidden')) {
        return true;
      }
      if (win && typeof win.getComputedStyle === 'function') {
        try {
          var pcomp = win.getComputedStyle(pCurr);
          if (pcomp && (pcomp.display === 'none' || pcomp.visibility === 'hidden')) {
            return true;
          }
        } catch {
          // safe
        }
      }
      pCurr = pCurr.parentElement;
    }

    if (!isJsdom) {
      var rect = typeof closestPanel.getBoundingClientRect === 'function' ? closestPanel.getBoundingClientRect() : null;
      var hasGeometry = closestPanel.offsetParent !== null || Boolean(rect && (rect.width > 0 || rect.height > 0));
      if (!hasGeometry) {
        return true;
      }
    }

    return false;
  });

  const isInForbiddenSubtabPanel = isAncestorPanelHidden;

  // Helper estricto para botón "Descargar Detalles" (NUNCA Resumenes ni Boletas)
  // @ts-expect-error browser runtime helper parameter
  const isCandidateDownloadButton = (0, function(b) {
    var norm = getButtonNormalizedText(b);

    if (!isDownloadDetalleText(norm)) {
      return false;
    }

    // Excluir si pertenece a subpestañas excluidas
    if (isInForbiddenSubtabPanel(b)) {
      return false;
    }

    // Exclusión de botones que estén dentro del contenedor de la pestaña OPUESTA solo si ese contenedor está realmente oculto
    if (isOppositeHidden(b, oppositeWords)) {
      return false;
    }

    // (c) Excluir candidatos dentro de paneles ocultos reales comprobando visibilidad efectiva
    if (!isElementVisible(b)) {
      return false;
    }

    return true;
  });

  // Búsqueda en la totalidad del documento directamente con filtros de seguridad
  const allButtons = Array.from(
    document.querySelectorAll('button, a, input[type="button"], [role="button"]')
  );
  const downloadBtn = allButtons.find(isCandidateDownloadButton);

  if (downloadBtn && typeof downloadBtn.click === 'function') {
    downloadBtn.click();
    return true;
  }
  return false;
}

export interface DownloadModalStatus {
  modalFound: boolean;
  confirmed: boolean;
  reason?: string;
}

/**
 * Maneja el diálogo modal de confirmación si aparece tras activar descarga.
 * Detecta y acepta SOLO el botón de confirmación del propio modal si existe de forma determinista.
 * Ejecutada en el navegador como JS puro serializable.
 */
export function evaluateHandleDownloadModal(): DownloadModalStatus {
  const modalCandidates = Array.from(
    document.querySelectorAll('.modal, [role="dialog"], .bootbox, .sweet-alert, .swal2-container, [uib-modal-window]')
  );

  const win = typeof window !== 'undefined' ? window : null;

  const visibleModals = modalCandidates.filter(function(m) {
    if (!m || m.hidden) return false;
    if (m.getAttribute && (m.getAttribute('hidden') !== null || m.getAttribute('aria-hidden') === 'true')) {
      return false;
    }
    const style = m.style || {};
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    if (win && typeof win.getComputedStyle === 'function') {
      try {
        const comp = win.getComputedStyle(m);
        if (comp && (comp.display === 'none' || comp.visibility === 'hidden')) {
          return false;
        }
      } catch {
        // safe
      }
    }

    const cls = (m.className || '').toString().toLowerCase();
    if (cls.indexOf('modal') !== -1) {
      const hasShowClass = cls.indexOf('in') !== -1 || cls.indexOf('show') !== -1;
      const hasBlockDisplay = style.display === 'block';
      let compBlock = false;
      if (win && typeof win.getComputedStyle === 'function') {
        try {
          const comp = win.getComputedStyle(m);
          compBlock = comp && comp.display === 'block';
        } catch {
          // safe
        }
      }
      if (!hasShowClass && !hasBlockDisplay && !compBlock) {
        return false;
      }
    }

    // El diálogo debe tener botones interactivos
    const hasButtons = m.querySelectorAll
      ? m.querySelectorAll('button, a.btn, input[type="button"], input[type="submit"], [role="button"]').length > 0
      : false;
    if (!hasButtons) {
      return false;
    }

    return true;
  });

  if (visibleModals.length === 0) {
    return { modalFound: false, confirmed: false };
  }

  const modalEl = visibleModals[0];
  if (!modalEl) {
    return { modalFound: false, confirmed: false };
  }

  // @ts-expect-error browser runtime helper parameter
  const normalizeText = (0, function(str) {
    if (!str) return '';
    return str
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  });

  const allButtons = Array.from(
    modalEl.querySelectorAll ? modalEl.querySelectorAll('button, a.btn, input[type="button"], input[type="submit"], [role="button"]') : []
  );

  const cancelPatterns = ['cancelar', 'cerrar', 'volver', 'no', 'abortar'];
  const confirmPatterns = ['confirmar', 'aceptar', 'si', 'continuar', 'descargar', 'proceder', 'ok'];

  const nonCancelButtons = allButtons.filter((b) => {
    const dataDismiss = (b.getAttribute ? b.getAttribute('data-dismiss') || b.getAttribute('data-bs-dismiss') : '') || '';
    if (dataDismiss.toLowerCase() === 'modal') return false;

    const cls = (b.className || '').toLowerCase();
    if (cls.includes('close') || cls.includes('cancel') || cls.includes('dismiss')) return false;

    const txt = normalizeText(b.textContent || b.value || '');
    if (cancelPatterns.some((p) => txt === p || txt.startsWith(p))) {
      return false;
    }
    return true;
  });

  const confirmCandidates = nonCancelButtons.filter((b) => {
    const txt = normalizeText(b.textContent || b.value || '');
    if (confirmPatterns.some((p) => txt === p || txt.startsWith(p) || txt.includes(p))) {
      return true;
    }
    const ngClick = (b.getAttribute ? b.getAttribute('ng-click') : '') || '';
    if (/confirmar|confirm|descargar|ok|accept/i.test(ngClick)) {
      return true;
    }
    const cls = (b.className || '').toLowerCase();
    if (cls.includes('btn-primary') || cls.includes('btn-success') || cls.includes('btn-confirm')) {
      return true;
    }
    return false;
  });

  if (confirmCandidates.length === 1) {
    const btnToClick = confirmCandidates[0];
    if (btnToClick && typeof btnToClick.click === 'function') {
      btnToClick.click();
      return { modalFound: true, confirmed: true };
    }
    return { modalFound: true, confirmed: false, reason: 'button_click_unavailable' };
  }

  if (confirmCandidates.length > 1) {
    const exactMatches = confirmCandidates.filter((b) => {
      const txt = normalizeText(b.textContent || b.value || '');
      return txt === 'confirmar' || txt === 'aceptar' || txt === 'si';
    });
    if (exactMatches.length === 1) {
      const btnToClick = exactMatches[0];
      if (btnToClick && typeof btnToClick.click === 'function') {
        btnToClick.click();
        return { modalFound: true, confirmed: true };
      }
    }
    return { modalFound: true, confirmed: false, reason: 'ambiguous_confirm_buttons' };
  }

  return { modalFound: true, confirmed: false, reason: 'no_confirm_button_found' };
}

export interface SelectAndInspectTabOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  reconsultPeriod?: boolean;
  requireConsultar?: boolean;
  maxActivationAttempts?: number;
}

/**
 * Selecciona la pestaña Compras o Ventas y ejecuta el flujo determinista y robusto:
 * (1) Activar la pestaña objetivo con verificación acotada de confirmación positiva (activeTabConfirmed=true)
 *     ANTES de inspeccionar; si no se confirma, reintenta un número acotado de veces alternando estrategias
 *     (click en anchor y navegación por hash a '#venta/' o '#compra/').
 * (2) Señal de seguridad: NO inspecciona ni descarga si activeTabConfirmed es false (evita descargar CSV
 *     de la pestaña equivocada); si tras los reintentos no se confirma, lanza TAB_ACTIVATION_FAILED (stage tab_selection).
 * (3) Volver a asegurar/seleccionar el período objetivo (año 2026, mes 02) y pulsar 'Consultar' nuevamente
 *     si el contenido aún no se encuentra renderizado.
 * (4) Esperar de forma acotada a que se renderice el resultado de ESA pestaña
 *     (aparición del botón 'Descargar Detalles' visible, o de la tabla resumen, o de un mensaje explícito de sin movimientos).
 * (5) Si es COMPRA y existen subpestañas, asegurar 'Registro' activa (href '#compraRegistro/') antes de inspeccionar.
 * (6) Recién entonces inspeccionar y exigir activeTabConfirmed y periodConfirmed tras la nueva consulta.
 *
 * Mantiene fail-closed, exclusión de Resúmenes/Boletas, visibilidad por renderizado real,
 * y clasificación legítima de 'empty' cuando el portal lo declara explícitamente.
 */
export async function selectAndInspectRcvTab(
  page: SiiPageLike,
  tab: RcvTabType,
  signal?: AbortSignal,
  period?: PeriodSelectionOptions,
  options?: SelectAndInspectTabOptions
): Promise<TabInspectionResult> {
  if (signal?.aborted) {
    throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499, undefined, { stage: 'tab_selection' });
  }

  const tabStartTime = Date.now();
  let consultarClicked = false;
  const isCompras = tab.toLowerCase().startsWith('compra');

  // (1) Activar la pestaña objetivo (Compras o Ventas), evitando elementos de la pestaña opuesta
  let tabFound = false;
  try {
    tabFound = await page.evaluate<boolean, string>(evaluateSwitchRcvTab, tab);
  } catch (err: unknown) {
    handleNavigationError(err, 'tab_selection');
  }

  if (!tabFound) {
    throw new AppError(
      'TAB_NOT_FOUND',
      `No se encontró la pestaña de "${tab}" en la interfaz del RCV.`,
      502,
      undefined,
      { stage: 'tab_selection' }
    );
  }

  await boundedHumanDelay(200, 350, signal);

  // Si es COMPRA y existen subpestañas antes de inspeccionar, asegurar 'Registro' activa
  if (tab === 'Compras') {
    try {
      const subtabResult = await page.evaluate<SwitchSubtabResult>(evaluateSwitchComprasRegistroSubtab);
      if (subtabResult?.registroClicked && !subtabResult?.alreadyActive) {
        await boundedHumanDelay(150, 250, signal);
      }
    } catch (err: unknown) {
      handleNavigationError(err, 'tab_selection');
    }
  }

  // Pre-inspección tolerante: si tras activar la pestaña el botón 'Descargar Detalles' ya está visible
  // y el período está confirmado y la pestaña está confirmada, NO volver a pulsar Consultar (evita descartar el render existente).
  // Solo re-consultar si el contenido no está renderizado.
  let preInspection: EvaluateInspectResult | null = null;
  try {
    preInspection = await page.evaluate<EvaluateInspectResult, {
      targetTab: string;
      expectedPeriod?: PeriodSelectionOptions | undefined;
    }>(
      evaluateInspectRcvActiveTab,
      { targetTab: tab, expectedPeriod: period }
    );
  } catch {
    preInspection = null;
  }

  const isContentAlreadyRendered = Boolean(
    preInspection &&
    preInspection.periodConfirmed &&
    preInspection.activeTabConfirmed &&
    (preInspection.hasDownloadButton || preInspection.hasNoMovements)
  );

  // (2) Volver a asegurar/seleccionar el período objetivo (año 2026, mes 02) y pulsar 'Consultar'
  // ÚNICAMENTE si el contenido no está renderizado aún (si el botón 'Descargar Detalles' ya está visible
  // y el período está confirmado, NO volver a pulsar Consultar para evitar descartar el render existente).
  const shouldReconsult = options?.reconsultPeriod ?? Boolean(options?.requireConsultar);
  if (!isContentAlreadyRendered && shouldReconsult && period) {
    await selectRcvPeriod(page, period, signal);

    let hasConsultarButton = false;
    try {
      hasConsultarButton = await page.evaluate<boolean>(evaluateHasConsultarButton);
    } catch (err: unknown) {
      handleNavigationError(err, 'query_button');
    }

    const shouldClickConsultar = hasConsultarButton || options?.requireConsultar;

    if (shouldClickConsultar) {
      let clicked = false;
      try {
        clicked = await page.evaluate<boolean>(evaluateClickConsultar);
      } catch (err: unknown) {
        handleNavigationError(err, 'query_button');
      }

      if (!clicked) {
        let locatorClicked = false;
        try {
          if (page.locator) {
            const consultarLocator = page.locator('button:has-text("Consultar"), input[value*="Consultar" i]').first();
            await consultarLocator.click({ timeout: 2000 });
            locatorClicked = true;
          }
        } catch {
          locatorClicked = false;
        }

        if (!locatorClicked) {
          throw new AppError(
            'QUERY_BUTTON_MISSING',
            'No fue posible activar el botón "Consultar" en el portal de RCV.',
            502,
            undefined,
            { stage: 'query_button' }
          );
        }
      }

      consultarClicked = true;
      await boundedHumanDelay(300, 600, signal);
    }
  }

  // (3) Esperar de forma acotada a que la pestaña objetivo esté confirmada y se renderice el resultado de ESA pestaña:
  // Si activeTabConfirmed es false, se reintenta la activación un número acotado de veces (hasta maxActivationAttempts, p.ej. 3)
  // alternando estrategias (click en anchor por id/href, navegación por hash #venta/ o #compra/).
  // Señal de seguridad: NO inspeccionar ni descargar si activeTabConfirmed es false (evita descargar CSV de pestaña equivocada).
  // Si tras los reintentos sigue sin confirmarse, devolver código tipado claro TAB_ACTIVATION_FAILED (stage tab_selection).
  const envRenderTimeout = process.env.RCV_TAB_RENDER_TIMEOUT_MS ? Number.parseInt(process.env.RCV_TAB_RENDER_TIMEOUT_MS, 10) : undefined;
  const defaultTimeout = process.env.NODE_ENV === 'test' ? 1000 : (Number.isFinite(envRenderTimeout) && envRenderTimeout! > 0 ? envRenderTimeout! : 25000);
  const defaultInterval = process.env.NODE_ENV === 'test' ? 40 : 200;
  const timeoutMs = options?.timeoutMs ?? defaultTimeout;
  const renderPollIntervalMs = options?.pollIntervalMs ?? defaultInterval;
  const maxActivationAttempts = options?.maxActivationAttempts ?? 3;
  let activationAttemptCount = 1;
  let lastActivationRetryTime = Date.now();

  let inspection: EvaluateInspectResult = (isContentAlreadyRendered && preInspection) ? preInspection : {
    hasNoMovements: false,
    hasDownloadButton: false,
    periodConfirmed: false,
    activeTabConfirmed: false,
    subtabRegistroFound: false,
    subtabRegistroActive: false,
    downloadButtonsFound: 0,
    detalleButtonFound: false,
    detalleButtonVisible: false,
    tableCount: 0,
    noMovementsPatternFound: false,
    hashEndsWith: '',
    downloadButtonLabels: [],
    detalleRejectedByOppositeContainer: false,
    detalleRejectedByVisibility: false,
    detalleRejectedBySubtabFilter: false,
  };

  const startTime = Date.now();
  while (Date.now() - startTime <= timeoutMs) {
    if (signal?.aborted) {
      throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499, undefined, { stage: 'tab_inspection' });
    }

    if (inspection.activeTabConfirmed && (inspection.hasDownloadButton || inspection.hasNoMovements)) {
      break;
    }

    // (4) Si es COMPRA y existen subpestañas, asegurar 'Registro' activa (href '#compraRegistro/') antes de inspeccionar
    if (tab === 'Compras') {
      try {
        const subtabResult = await page.evaluate<SwitchSubtabResult>(evaluateSwitchComprasRegistroSubtab);
        if (subtabResult?.registroClicked && !subtabResult?.alreadyActive) {
          await boundedHumanDelay(200, 350, signal);
        }
      } catch (err: unknown) {
        handleNavigationError(err, 'tab_selection');
      }
    }

    try {
      inspection = await page.evaluate<EvaluateInspectResult, {
        targetTab: string;
        expectedPeriod?: PeriodSelectionOptions | undefined;
      }>(
        evaluateInspectRcvActiveTab,
        { targetTab: tab, expectedPeriod: period }
      );
    } catch (err: unknown) {
      handleNavigationError(err, 'tab_inspection');
    }

    if (inspection.activeTabConfirmed && (inspection.hasDownloadButton || inspection.hasNoMovements)) {
      break;
    }

    // Si la pestaña NO está confirmada activa, reintentar la activación un número acotado de veces alternando estrategias
    const activationRetryIntervalMs = process.env.NODE_ENV === 'test' ? 80 : 1200;
    if (
      !inspection.activeTabConfirmed &&
      activationAttemptCount < maxActivationAttempts &&
      Date.now() - lastActivationRetryTime >= activationRetryIntervalMs
    ) {
      activationAttemptCount++;
      lastActivationRetryTime = Date.now();

      const useHash = activationAttemptCount > 1;
      try {
        if (useHash) {
          await page.evaluate<boolean, { targetTab: string; useHash: boolean }>(
            evaluateSwitchRcvTab,
            { targetTab: tab, useHash: true }
          );
        } else {
          await page.evaluate<boolean, string>(evaluateSwitchRcvTab, tab);
        }
      } catch {
        // safe retry
      }

      if (page.locator) {
        try {
          const sel = isCompras
            ? '#tabCompra, #tabcompras, #tab-compra, a[href="#compra/"], a[href="#compra"]'
            : '#tabVenta, #tabventas, #tab-venta, a[href="#venta/"], a[href="#venta"]';
          await page.locator(sel).first().click({ timeout: 800 }).catch(() => {});
        } catch {
          // safe
        }
      }

      await boundedHumanDelay(100, 200, signal);

      // Si el contenido no se renderiza tras reintentar la activación, re-consultar el período
      if (period && (!inspection.periodConfirmed || inspection.tableCount === 0)) {
        try {
          await selectRcvPeriod(page, period, signal);
          const clicked = await page.evaluate<boolean>(evaluateClickConsultar);
          if (clicked) {
            consultarClicked = true;
          }
          await boundedHumanDelay(150, 300, signal);
        } catch {
          // safe retry
        }
      }

      continue;
    }

    // Comprobar si el portal mostró un mensaje de error explícito al consultar
    try {
      const status = await checkRcvResultsStatus(page, period);
      if (status.hasErrorMessage && !status.hasTabs && status.tableCount === 0) {
        throw new AppError(
          'RESULTS_NOT_RENDERED',
          'El portal de RCV mostró un mensaje de error al consultar el período.',
          502,
          undefined,
          { stage: 'results_render' }
        );
      }
    } catch (err: unknown) {
      if (isAppError(err) && err.code === 'RESULTS_NOT_RENDERED') {
        throw err;
      }
      // safe
    }

    if (Date.now() - startTime >= timeoutMs) {
      break;
    }

    await boundedHumanDelay(renderPollIntervalMs, renderPollIntervalMs + 50, signal);
  }

  // (5) Recién entonces retornar inspección (exigiendo activeTabConfirmed y periodConfirmed)
  const elapsedMsInTab = Date.now() - tabStartTime;
  const tabDiagnostic: RcvTabDiagnostic = {
    activeTabConfirmed: Boolean(inspection.activeTabConfirmed),
    periodConfirmed: Boolean(inspection.periodConfirmed),
    subtabRegistroFound: Boolean(inspection.subtabRegistroFound),
    subtabRegistroActive: Boolean(inspection.subtabRegistroActive),
    downloadButtonsFound: typeof inspection.downloadButtonsFound === 'number' ? inspection.downloadButtonsFound : 0,
    detalleButtonFound: Boolean(inspection.detalleButtonFound),
    detalleButtonVisible: Boolean(inspection.detalleButtonVisible),
    tableCount: typeof inspection.tableCount === 'number' ? inspection.tableCount : 0,
    noMovementsPatternFound: Boolean(inspection.noMovementsPatternFound),
    consultarClicked,
    hashEndsWith: typeof inspection.hashEndsWith === 'string' ? inspection.hashEndsWith : '',
    elapsedMsInTab,
    downloadButtonLabels: Array.isArray(inspection.downloadButtonLabels) ? inspection.downloadButtonLabels : [],
    detalleRejectedByOppositeContainer: Boolean(inspection.detalleRejectedByOppositeContainer),
    detalleRejectedByVisibility: Boolean(inspection.detalleRejectedByVisibility),
    detalleRejectedBySubtabFilter: Boolean(inspection.detalleRejectedBySubtabFilter),
  };

  // (6) Señal de seguridad: NO inspeccionar ni descargar si activeTabConfirmed es false (evita descargar el CSV de la pestaña equivocada)
  // Si tras los reintentos sigue sin confirmarse, devolver código tipado claro TAB_ACTIVATION_FAILED (stage tab_selection)
  const isFinalConfirmed = Boolean(
    inspection.activeTabConfirmed === true ||
    (inspection.activeTabConfirmed === undefined && (inspection.hasDownloadButton || inspection.hasNoMovements))
  );

  if (!isFinalConfirmed) {
    throw new AppError(
      'TAB_ACTIVATION_FAILED',
      `No fue posible activar ni confirmar la pestaña activa de "${tab}" en el portal de RCV tras los intentos de selección.`,
      502,
      undefined,
      {
        stage: 'tab_selection',
        tabDiagnostic,
      }
    );
  }

  return {
    hasNoMovements: inspection.hasNoMovements,
    canDownload: inspection.hasDownloadButton,
    periodConfirmed: inspection.periodConfirmed,
    activeTabConfirmed: inspection.activeTabConfirmed,
    tabDiagnostic,
  };
}

/**
 * Detona la descarga de detalles del RCV en la pestaña actualmente activa.
 */
export async function triggerRcvDownload(
  page: SiiPageLike,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499, undefined, { stage: 'download_trigger' });
  }

  // 1. Snapshot previo de data URIs existentes en el DOM (para distinguir uno nuevo tras el click)
  let priorDataUris: string[] = [];
  try {
    const uris = await page.evaluate<string[]>(evaluateCollectDataUriAnchors);
    if (Array.isArray(uris)) {
      priorDataUris = uris;
    }
  } catch {
    priorDataUris = [];
  }

  // 2. Click en Descargar Detalles
  let triggered = false;
  try {
    triggered = await page.evaluate<boolean>(evaluateClickDownloadCsv);
  } catch (err: unknown) {
    handleNavigationError(err, 'download_trigger');
  }

  if (!triggered) {
    throw new AppError(
      'DOWNLOAD_TRIGGER_FAILED',
      'No fue posible activar el botón "Descargar detalles" en el portal de RCV.',
      502,
      undefined,
      { stage: 'download_trigger' }
    );
  }

  // 3. Esperar primero el anchor data:text/csv nuevo, y solo exigir modal si realmente aparece un diálogo visible
  const waitTimeoutMs = process.env.NODE_ENV === 'test' ? 300 : 1500;
  const pollIntervalMs = process.env.NODE_ENV === 'test' ? 40 : 150;
  const startTime = Date.now();

  let modalResult: DownloadModalStatus = { modalFound: false, confirmed: false };
  let newDataUriDetected = false;

  while (Date.now() - startTime <= waitTimeoutMs) {
    if (signal?.aborted) {
      throw signal.reason || new AppError('OPERATION_ABORTED', 'Operación cancelada.', 499, undefined, { stage: 'download_trigger' });
    }

    // A. Comprobar primero si ya apareció un nuevo Data URI de CSV en el DOM (sin consumirlo)
    try {
      const currentUris = await page.evaluate<string[]>(evaluateCollectDataUriAnchors);
      if (Array.isArray(currentUris)) {
        const hasNew = currentUris.some((href) => !priorDataUris.includes(href));
        if (hasNew) {
          newDataUriDetected = true;
          break;
        }
      }
    } catch {
      // safe
    }

    // B. Comprobar si apareció un modal visible de confirmación (ej: límite superado)
    try {
      const modalCheck = await page.evaluate<DownloadModalStatus>(evaluateHandleDownloadModal);
      if (typeof modalCheck === 'object' && modalCheck !== null && modalCheck.modalFound) {
        modalResult = modalCheck;
        break;
      }
    } catch (err: unknown) {
      handleNavigationError(err, 'download_trigger');
    }

    await boundedHumanDelay(pollIntervalMs, pollIntervalMs + 30, signal);
  }

  // Si ya apareció un nuevo Data URI, la descarga se inició directamente sin necesidad de modal
  if (newDataUriDetected) {
    return;
  }

  // Si se encontró un modal visible real, resolverlo deterministamente o lanzar DOWNLOAD_CONFIRM_REQUIRED
  if (typeof modalResult === 'object' && modalResult !== null && modalResult.modalFound) {
    if (!modalResult.confirmed) {
      throw new AppError(
        'DOWNLOAD_CONFIRM_REQUIRED',
        'Se requiere confirmación para la descarga pero el diálogo no pudo resolverse de forma determinista.',
        502,
        undefined,
        { stage: 'download_trigger' }
      );
    }
  }
}

export interface ExtractDataUriResult {
  found: boolean;
  href?: string;
  tooLarge?: boolean;
  approxLength?: number;
}

/**
 * Recolecta todos los enlaces con Data URI de CSV existentes en el DOM antes de la descarga.
 * Ejecutada en el navegador como JS puro serializable.
 */
export function evaluateCollectDataUriAnchors(): string[] {
  // @ts-expect-error browser runtime helper parameter
  const isCsvDataUri = (0, function(href) {
    if (!href || typeof href !== 'string') return false;
    if (href.indexOf('data:') !== 0) return false;
    var commaIdx = href.indexOf(',');
    if (commaIdx === -1) return false;
    var header = href.slice(0, commaIdx).toLowerCase();
    var isCsvMime =
      header.indexOf('text/csv') !== -1 ||
      header.indexOf('application/csv') !== -1 ||
      header.indexOf('application/vnd.ms-excel') !== -1;
    if (isCsvMime) return true;
    if (header.indexOf('text/plain') !== -1) {
      var sample = href.slice(commaIdx + 1, commaIdx + 300).toLowerCase();
      return (
        sample.indexOf(';') !== -1 ||
        sample.indexOf('%0a') !== -1 ||
        sample.indexOf('\n') !== -1 ||
        sample.indexOf('rut') !== -1 ||
        sample.indexOf('tipo') !== -1
      );
    }
    return false;
  });

  var anchors = Array.from(document.querySelectorAll('a[href^="data:"], a'));
  var result = [];
  for (var i = 0; i < anchors.length; i++) {
    var a = anchors[i];
    if (!a) continue;
    var href = (a.getAttribute ? a.getAttribute('href') : '') || a.href || '';
    if (isCsvDataUri(href)) {
      result.push(href);
    }
  }
  return result;
}

/**
 * Busca en el DOM un nuevo enlace con Data URI de CSV que no existiera antes del click.
 * Si lo encuentra, extrae su href y remueve el enlace del DOM para no confundir capturas posteriores.
 * Ejecutada en el navegador como JS puro serializable.
 */
export function evaluateExtractNewDataUri(params?: {
  priorHrefs?: string[] | undefined;
  maxBytes?: number | undefined;
}): ExtractDataUriResult {
  var prior = (params && params.priorHrefs) ? params.priorHrefs : [];
  var maxBytes = (params && params.maxBytes) ? params.maxBytes : 10485760;

  // @ts-expect-error browser runtime helper parameter
  const isCsvDataUri = (0, function(href) {
    if (!href || typeof href !== 'string') return false;
    if (href.indexOf('data:') !== 0) return false;
    var commaIdx = href.indexOf(',');
    if (commaIdx === -1) return false;
    var header = href.slice(0, commaIdx).toLowerCase();
    var isCsvMime =
      header.indexOf('text/csv') !== -1 ||
      header.indexOf('application/csv') !== -1 ||
      header.indexOf('application/vnd.ms-excel') !== -1;
    if (isCsvMime) return true;
    if (header.indexOf('text/plain') !== -1) {
      var sample = href.slice(commaIdx + 1, commaIdx + 300).toLowerCase();
      return (
        sample.indexOf(';') !== -1 ||
        sample.indexOf('%0a') !== -1 ||
        sample.indexOf('\n') !== -1 ||
        sample.indexOf('rut') !== -1 ||
        sample.indexOf('tipo') !== -1
      );
    }
    return false;
  });

  var anchors = Array.from(document.querySelectorAll('a[href^="data:"], a'));
  var matchedAnchor = null;
  var matchedHref = '';

  for (var i = 0; i < anchors.length; i++) {
    var a = anchors[i];
    if (!a) continue;
    var href = (a.getAttribute ? a.getAttribute('href') : '') || a.href || '';
    if (isCsvDataUri(href)) {
      var isPrior = false;
      for (var j = 0; j < prior.length; j++) {
        if (prior[j] === href) {
          isPrior = true;
          break;
        }
      }
      if (!isPrior) {
        matchedAnchor = a;
        matchedHref = href;
        break;
      }
    }
  }

  if (!matchedAnchor || !matchedHref) {
    return { found: false };
  }

  // Comprobación temprana de límite antes de transferir por CDP
  var comma = matchedHref.indexOf(',');
  var payloadLen = comma >= 0 ? matchedHref.length - comma - 1 : matchedHref.length;
  if (payloadLen > maxBytes * 3) {
    try {
      if (matchedAnchor.parentNode && typeof matchedAnchor.parentNode.removeChild === 'function') {
        matchedAnchor.parentNode.removeChild(matchedAnchor);
      } else if (typeof matchedAnchor.remove === 'function') {
        matchedAnchor.remove();
      }
      if (typeof matchedAnchor.removeAttribute === 'function') {
        matchedAnchor.removeAttribute('href');
      }
    } catch {
      // safe
    }
    return { found: true, tooLarge: true, approxLength: payloadLen };
  }

  // Remover / limpiar referencia en el DOM para evitar confusiones en pestañas subsecuentes
  try {
    if (matchedAnchor.parentNode && typeof matchedAnchor.parentNode.removeChild === 'function') {
      matchedAnchor.parentNode.removeChild(matchedAnchor);
    } else if (typeof matchedAnchor.remove === 'function') {
      matchedAnchor.remove();
    }
    if (typeof matchedAnchor.removeAttribute === 'function') {
      matchedAnchor.removeAttribute('href');
    }
  } catch {
    // safe
  }

  return {
    found: true,
    href: matchedHref,
  };
}

/**
 * Recolecta los Data URIs de CSV preexistentes en la página.
 */
export async function collectExistingDataUris(page: SiiPageLike): Promise<string[]> {
  try {
    return await page.evaluate<string[]>(evaluateCollectDataUriAnchors);
  } catch {
    return [];
  }
}

/**
 * Extrae un nuevo Data URI de CSV generado en el DOM tras la acción de descarga.
 */
export async function extractNewDataUri(
  page: SiiPageLike,
  priorHrefs?: string[],
  maxBytes?: number
): Promise<ExtractDataUriResult> {
  try {
    return await page.evaluate<ExtractDataUriResult, { priorHrefs?: string[] | undefined; maxBytes?: number | undefined }>(
      evaluateExtractNewDataUri,
      { priorHrefs, maxBytes }
    );
  } catch (err: unknown) {
    handleNavigationError(err, 'download_capture');
  }
}

