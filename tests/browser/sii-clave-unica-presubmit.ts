import { BrowserSession } from '../../server/src/infrastructure/sii/browserSession.js';
import { assertClaveUnicaFormSecurity, formatRutForClaveUnica } from '../../server/src/infrastructure/sii/claveUnicaAuth.js';
import { parseExactOrigin, boundedHumanDelay } from '../../server/src/infrastructure/sii/siiPage.js';
import { AppError } from '../../server/src/domain/errors.js';

interface ClaveUnicaPreSubmitEvidence {
  mode: 'clave-unica';
  status: 'SUCCESS' | 'FAILED';
  phase: 'formulario';
  pageOrigin: string | null;
  formOrigin: string | null;
  formActionPath: string | null;
  formMethod: string | null;
  controlsReady: {
    hasRunInput: boolean;
    hasPasswordInput: boolean;
    hasSubmitButton: boolean;
  };
  syntheticRunValidation: {
    rawInput: string;
    formattedRun: string;
    domValidationPassed: boolean;
    buttonDisabledInitially: boolean;
  };
  securityCheckPassed: boolean;
  authenticationAttempted: false;
  elapsedMs: number;
}

const RCV_PORTAL_URL = 'https://www4.sii.cl/consdcvinternetui/#/index';
const ZEUSR_ALLOWED_ORIGIN = 'https://zeusr.sii.cl';
const CLAVE_UNICA_ALLOWED_ORIGIN = 'https://accounts.claveunica.gob.cl';

async function runClaveUnicaPreSubmitVerification(): Promise<void> {
  const started = Date.now();
  let session: BrowserSession | undefined;

  try {
    session = await BrowserSession.start({
      headless: true,
    });

    // 1. Navegar al portal RCV oficial (redirige a zeusr.sii.cl para autenticación)
    await session.page.goto(RCV_PORTAL_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    const zeusrUrl = await session.page.url();
    const zeusrOrigin = parseExactOrigin(zeusrUrl)?.origin;

    if (zeusrOrigin !== ZEUSR_ALLOWED_ORIGIN) {
      throw new AppError(
        'NAVIGATION_ERROR',
        'La navegación inicial no aterrizó en el origen seguro del SII esperado.',
        502
      );
    }

    // 2. Esperar y pulsar enlace oficial de Clave Única (#myHref)
    if (session.page.waitForSelector) {
      await session.page.waitForSelector('#myHref', { timeout: 15000 }).catch(() => {});
    }

    const claveUnicaLink = session.page.locator('#myHref');
    await claveUnicaLink.click();

    // 3. Esperar a que la navegación alcance el origen oficial de Clave Única
    const waitLimit = Date.now() + 15000;
    let cuUrl = '';
    while (Date.now() < waitLimit) {
      const currentUrl = await session.page.url();
      const parsedCheck = parseExactOrigin(currentUrl);
      if (parsedCheck?.origin === CLAVE_UNICA_ALLOWED_ORIGIN) {
        cuUrl = currentUrl;
        break;
      }
      if (parsedCheck?.origin !== ZEUSR_ALLOWED_ORIGIN) {
        throw new AppError(
          'SECURITY_VIOLATION',
          'El portal no se encuentra en el origen seguro permitido.',
          502
        );
      }
      await boundedHumanDelay(200, 300);
    }

    if (!cuUrl) {
      throw new AppError('TIMEOUT', 'Tiempo de espera agotado para alcanzar Clave Única.', 504);
    }

    // 4. Validar formulario y origen seguro con assertClaveUnicaFormSecurity sin rellenar nada
    await assertClaveUnicaFormSecurity(session.page);

    // 5. Inspeccionar atributos seguros y controles del formulario sin datos ni credenciales
    const formAudit = await session.page.evaluate(() => {
      const form = document.querySelector('form#login-form');
      const runEl = document.querySelector('form#login-form #uname, form#login-form input#uname');
      const passEl = document.querySelector('form#login-form #pword, form#login-form input#pword');
      const btnEl = document.querySelector('form#login-form #login-submit, form#login-form button#login-submit');

      const runAttributes = {};
      if (runEl) {
        for (let i = 0; i < runEl.attributes.length; i++) {
          const attr = runEl.attributes[i];
          runAttributes[attr.name] = attr.value;
        }
      }

      return {
        formAction: form?.action || '',
        formMethod: (form?.method || '').toLowerCase(),
        hasRunInput: Boolean(runEl),
        hasPasswordInput: Boolean(passEl),
        hasSubmitButton: Boolean(btnEl),
        buttonDisabledInitially: Boolean(btnEl?.disabled ?? true),
      };
    });

    // 6. Prueba con RUN sintético para validar normalización puntos-guión y eventos sin contraseña ni submit
    const syntheticRawRun = '11111111-1';
    const formattedRun = formatRutForClaveUnica(syntheticRawRun);

    const runInputLocator = session.page.locator('#uname');
    await runInputLocator.fill(formattedRun);

    const syntheticValidation = await session.page.evaluate(() => {
      const runEl = document.querySelector('#uname');
      if (runEl) {
        runEl.dispatchEvent(new Event('input', { bubbles: true }));
        runEl.dispatchEvent(new Event('change', { bubbles: true }));
        runEl.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '1' }));
        runEl.dispatchEvent(new Event('blur', { bubbles: true }));
      }

      const runGroup = runEl?.closest('.group-label');
      const hasError = runGroup?.classList.contains('control-error') ?? false;

      // Limpiar inmediatamente el campo
      if (runEl) {
        runEl.value = '';
        runEl.dispatchEvent(new Event('input', { bubbles: true }));
      }

      return {
        domValidationPassed: !hasError,
      };
    });

    const parsedAction = parseExactOrigin(formAudit.formAction);

    const evidence: ClaveUnicaPreSubmitEvidence = {
      mode: 'clave-unica',
      status: 'SUCCESS',
      phase: 'formulario',
      pageOrigin: parseExactOrigin(cuUrl)?.origin ?? null,
      formOrigin: parsedAction?.origin ?? null,
      formActionPath: parsedAction?.pathname ?? null,
      formMethod: formAudit.formMethod,
      controlsReady: {
        hasRunInput: formAudit.hasRunInput,
        hasPasswordInput: formAudit.hasPasswordInput,
        hasSubmitButton: formAudit.hasSubmitButton,
      },
      syntheticRunValidation: {
        rawInput: syntheticRawRun,
        formattedRun,
        domValidationPassed: syntheticValidation.domValidationPassed,
        buttonDisabledInitially: formAudit.buttonDisabledInitially,
      },
      securityCheckPassed: true,
      authenticationAttempted: false,
      elapsedMs: Date.now() - started,
    };

    console.log(JSON.stringify(evidence, null, 2));
  } catch (error: unknown) {
    const safeCode = error instanceof AppError ? error.code : 'TECHNICAL_ERROR';
    console.error('ERROR STACK:', error);
    const failedEvidence: ClaveUnicaPreSubmitEvidence = {
      mode: 'clave-unica',
      status: 'FAILED',
      phase: 'formulario',
      pageOrigin: null,
      formOrigin: null,
      formActionPath: null,
      formMethod: null,
      controlsReady: {
        hasRunInput: false,
        hasPasswordInput: false,
        hasSubmitButton: false,
      },
      securityCheckPassed: false,
      authenticationAttempted: false,
      elapsedMs: Date.now() - started,
    };
    console.error(JSON.stringify({ ...failedEvidence, code: safeCode }));
    process.exitCode = 1;
  } finally {
    if (session) {
      await session.close().catch(() => {});
    }
  }
}

runClaveUnicaPreSubmitVerification();
