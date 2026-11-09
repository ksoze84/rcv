import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { AuthAttemptGuard } from '../src/infrastructure/sii/authAttemptGuard.js';
import {
  authenticateTributaria,
  formatRutForTributaria,
  evaluateTributariaFormMeta,
} from '../src/infrastructure/sii/tributariaAuth.js';
import {
  assertClaveUnicaFormSecurity,
  authenticateClaveUnica,
  formatRutForClaveUnica,
  evaluateClaveUnicaFormMeta,
  evaluateClaveUnicaFormFields,
  evaluateClaveUnicaFormValidation,
  evaluateClaveUnicaPostSubmitState,
} from '../src/infrastructure/sii/claveUnicaAuth.js';
import { AppError } from '../src/domain/errors.js';
import {
  SiiPageLike,
  evaluateDomAuthState,
  evaluateAuthPollingSnapshot,
  extractSafeOriginAndPath,
  parseExactOrigin,
  pollAuthenticationResult,
} from '../src/infrastructure/sii/siiPage.js';

describe('parseExactOrigin', () => {
  it('parses valid HTTPS origin without credentials', () => {
    const parsed = parseExactOrigin('https://zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoRutClave.html');
    expect(parsed?.origin).toBe('https://zeusr.sii.cl');
  });

  it('rejects HTTP protocol', () => {
    expect(parseExactOrigin('http://zeusr.sii.cl/login')).toBeNull();
  });

  it('rejects URLs containing username or password', () => {
    expect(parseExactOrigin('https://user:pass@zeusr.sii.cl/login')).toBeNull();
  });

  it('correctly isolates malicious origins with domain prefixes', () => {
    const parsed = parseExactOrigin('https://accounts.claveunica.gob.cl.evil/accounts/login');
    expect(parsed?.origin).toBe('https://accounts.claveunica.gob.cl.evil');
    expect(parsed?.origin).not.toBe('https://accounts.claveunica.gob.cl');
  });
});

describe('extractSafeOriginAndPath', () => {
  it('extracts origin and path while stripping query parameters and hash', () => {
    const res = extractSafeOriginAndPath(
      'https://accounts.claveunica.gob.cl/accounts/login/?next=/cgi_AUT2000/CAutClaveUnica.cgi?token=SECRET123#myanchor'
    );
    expect(res.origin).toBe('https://accounts.claveunica.gob.cl');
    expect(res.path).toBe('/accounts/login/');
    expect(JSON.stringify(res)).not.toContain('SECRET123');
    expect(JSON.stringify(res)).not.toContain('myanchor');
  });

  it('handles relative or invalid URLs gracefully', () => {
    const res = extractSafeOriginAndPath('not-a-url');
    expect(res.origin).toBeNull();
    expect(res.path).toBeNull();
  });
});

describe('evaluateDomAuthState', () => {
  it('detects account blocked message with narrow matching', () => {
    const res = evaluateDomAuthState({
      url: 'https://zeusr.sii.cl/error',
      bodyText: 'Su cuenta ha sido bloqueada por demasiados intentos.',
      hasVisibleCaptcha: false,
    });
    expect(res.state).toBe('account_blocked');
    expect(res.retryAfterSeconds).toBe(1800);
  });

  it('does not classify generic informational text as account blocked', () => {
    const res = evaluateDomAuthState({
      url: 'https://zeusr.sii.cl/login',
      bodyText: 'Para consultas sobre bloqueo de tarjetas bancarias ingrese a su banco.',
      hasVisibleCaptcha: false,
    });
    // Should be pending, not account_blocked
    expect(res.state).toBe('pending');
  });

  it('detects challenge required when visible captcha exists', () => {
    const res = evaluateDomAuthState({
      url: 'https://zeusr.sii.cl/login',
      bodyText: 'Por favor complete el captcha',
      hasVisibleCaptcha: true,
    });
    expect(res.state).toBe('challenge_required');
  });

  it('detects challenge required when visible mfa exists', () => {
    const res = evaluateDomAuthState({
      url: 'https://zeusr.sii.cl/login',
      bodyText: 'Ingrese código',
      hasVisibleCaptcha: false,
      hasMfaOrChallenge: true,
    });
    expect(res.state).toBe('challenge_required');
  });

  it('detects explicit invalid credentials message only', () => {
    const res = evaluateDomAuthState({
      url: 'https://zeusr.sii.cl/login',
      bodyText: 'La clave tributaria ingresada no es correcta.',
      hasVisibleCaptcha: false,
    });
    expect(res.state).toBe('invalid_credentials');
  });

  it('defaults to pending on login page without error messages', () => {
    const res = evaluateDomAuthState({
      url: 'https://zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoRutClave.html',
      bodyText: 'Ingrese su RUT y Clave Tributaria para acceder al portal.',
      hasVisibleCaptcha: false,
    });
    expect(res.state).toBe('pending');
  });

  it('returns redirected only for exact protected RCV URL', () => {
    const res = evaluateDomAuthState({
      url: 'https://www4.sii.cl/consdcvinternetui/#/index',
      bodyText: 'Registro de Compras y Ventas',
      hasVisibleCaptcha: false,
    });
    expect(res.state).toBe('redirected');
  });

  it('never considers public sii home as success or redirected', () => {
    const res = evaluateDomAuthState({
      url: 'https://www.sii.cl/',
      bodyText: 'Servicio de Impuestos Internos - Portada',
      hasVisibleCaptcha: false,
    });
    expect(res.state).toBe('pending');
  });

  it('rejects attacker domain pretending to be RCV portal', () => {
    const res = evaluateDomAuthState({
      url: 'https://www4.sii.cl.attacker.com/consdcvinternetui/#/index',
      bodyText: 'Fake Portal',
      hasVisibleCaptcha: false,
    });
    expect(res.state).toBe('pending');
  });
});

describe('pollAuthenticationResult', () => {
  it('transitions from pending to redirected across poll intervals', async () => {
    let callCount = 0;
    const fakePage: SiiPageLike = {
      url: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          return 'https://zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoRutClave.html';
        }
        return 'https://www4.sii.cl/consdcvinternetui/#/index';
      }),
      evaluate: vi.fn().mockResolvedValue({
        bodyText: 'Cargando...',
        hasVisibleCaptcha: false,
        hasMfaOrChallenge: false,
      }),
      locator: vi.fn(),
    };

    const result = await pollAuthenticationResult(fakePage, undefined, 5000, 50);
    expect(result.state).toBe('redirected');
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it('resiliently handles evaluate navigation errors during page lifecycle transitions', async () => {
    let evaluateCalls = 0;
    const fakePage: SiiPageLike = {
      url: vi.fn().mockResolvedValue('https://www4.sii.cl/consdcvinternetui/#/index'),
      evaluate: vi.fn().mockImplementation(async () => {
        evaluateCalls++;
        if (evaluateCalls === 1) {
          throw new Error('Execution context was destroyed, most likely because of a navigation.');
        }
        return {
          bodyText: 'Registro de Compras y Ventas',
          hasVisibleCaptcha: false,
          hasMfaOrChallenge: false,
        };
      }),
      locator: vi.fn(),
    };

    const result = await pollAuthenticationResult(fakePage, undefined, 3000, 50);
    expect(result.state).toBe('redirected');
  });

  it('propagates abort signal immediately', async () => {
    const controller = new AbortController();
    controller.abort(new Error('User aborted'));

    const fakePage: SiiPageLike = {
      url: vi.fn().mockResolvedValue('https://zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoRutClave.html'),
      evaluate: vi.fn().mockResolvedValue({
        bodyText: '',
        hasVisibleCaptcha: false,
        hasMfaOrChallenge: false,
      }),
      locator: vi.fn(),
    };

    await expect(
      pollAuthenticationResult(fakePage, controller.signal, 5000, 50)
    ).rejects.toThrow('User aborted');
  });
});

describe('formatRut utilities', () => {
  it('formats RUT for Tributaria and Clave Única', () => {
    expect(formatRutForTributaria(' 12.345.678-k ')).toBe('12345678-K');
    expect(formatRutForClaveUnica(' 12.345.678-k ')).toBe('12.345.678-K');
    expect(formatRutForClaveUnica('12345678-k')).toBe('12.345.678-K');
    expect(formatRutForClaveUnica('12345678k')).toBe('12.345.678-K');
    expect(formatRutForClaveUnica('1234567-8')).toBe('1.234.567-8');
    expect(formatRutForClaveUnica('11111111-1')).toBe('11.111.111-1');
  });
});

describe('authenticateTributaria flow', () => {
  let tempDir: string;
  let guard: AuthAttemptGuard;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `guard-test-${Date.now()}-${Math.random()}`);
    guard = new AuthAttemptGuard(tempDir);
  });

  it('rejects evil origin BEFORE any fill action is executed', async () => {
    const fakeLocator = {
      fill: vi.fn(),
      click: vi.fn(),
      selectOption: vi.fn(),
      first: vi.fn(),
      nth: vi.fn(),
    };

    const fakePage: SiiPageLike = {
      url: () => 'https://zeusr.sii.cl.evil.com/AUT2000/InicioAutenticacion/IngresoRutClave.html',
      evaluate: vi.fn(),
      locator: vi.fn().mockReturnValue(fakeLocator),
    };

    await expect(
      authenticateTributaria({
        page: fakePage,
        rut: '11111111-1',
        password: 'secretpassword',
        guard,
      })
    ).rejects.toThrow(AppError);

    expect(fakeLocator.fill).not.toHaveBeenCalled();
    expect(fakeLocator.click).not.toHaveBeenCalled();
  });

  it('rejects form with GET method (methodgetreject)', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoRutClave.html',
      evaluate: vi.fn().mockResolvedValue({
        exists: true,
        actionUrl: 'https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi',
        method: 'get',
      }),
      locator: vi.fn(),
    };

    await expect(
      authenticateTributaria({
        page: fakePage,
        rut: '11111111-1',
        password: 'secretpassword',
        guard,
      })
    ).rejects.toThrow('El método del formulario de autenticación tributaria no es POST seguro.');
  });

  it('rejects form action targeting untrusted destination or path', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoRutClave.html',
      evaluate: vi.fn().mockResolvedValue({
        exists: true,
        actionUrl: 'https://zeusr.sii.cl.attacker.com/cgi_AUT2000/CAutInicio.cgi',
        method: 'post',
      }),
      locator: vi.fn(),
    };

    await expect(
      authenticateTributaria({
        page: fakePage,
        rut: '11111111-1',
        password: 'secretpassword',
        guard,
      })
    ).rejects.toThrow('La acción del formulario no apunta al destino oficial seguro permitido.');
  });

  it('never logs URL tokens or sensitive query state in security error messages (nologtokenURL)', async () => {
    const tokenQuery = '?token=SUPER_SECRET_TOKEN_12345&state=SENSITIVE_STATE';
    const fakePage: SiiPageLike = {
      url: () => `https://zeusr.sii.cl.evil.com/login${tokenQuery}`,
      evaluate: vi.fn(),
      locator: vi.fn(),
    };

    let caughtError: AppError | undefined;
    try {
      await authenticateTributaria({
        page: fakePage,
        rut: '11111111-1',
        password: 'secretpassword',
        guard,
      });
    } catch (err) {
      caughtError = err as AppError;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError?.message).not.toContain('SUPER_SECRET_TOKEN_12345');
    expect(caughtError?.message).not.toContain('SENSITIVE_STATE');
    expect(caughtError?.message).not.toContain('https://');
  });

  it('executes successful flow with exactly one click and reserves attempt before click (oneclick max)', async () => {
    let clickedCount = 0;
    let reservedBeforeClick = false;

    const originalReserve = guard.reserveAttempt.bind(guard);
    guard.reserveAttempt = async (sec) => {
      if (clickedCount === 0) {
        reservedBeforeClick = true;
      }
      return originalReserve(sec);
    };

    let urlValue = 'https://zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoRutClave.html';

    const fakeLocator = {
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockImplementation(async () => {
        clickedCount++;
        urlValue = 'https://www4.sii.cl/consdcvinternetui/#/index';
      }),
    };

    const fakePage: SiiPageLike = {
      url: () => urlValue,
      evaluate: vi.fn().mockImplementation(async (fn) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('form#myform')) {
            return {
              exists: true,
              actionUrl: 'https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi',
              method: 'post',
            };
          }
          return {
            bodyText: 'Registro de Compras y Ventas',
            hasVisibleCaptcha: false,
            hasMfaOrChallenge: false,
          };
        }
        return {
          exists: true,
          actionUrl: 'https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi',
          method: 'post',
        };
      }),
      locator: vi.fn().mockReturnValue(fakeLocator),
    };

    await authenticateTributaria({
      page: fakePage,
      rut: '11111111-1',
      password: 'secretpassword',
      guard,
    });

    expect(reservedBeforeClick).toBe(true);
    expect(clickedCount).toBe(1);
    expect(fakeLocator.fill).toHaveBeenCalledTimes(2);
  });

  it('marks guard blocked >= 1800s and does not retry on account blocked (blockedno retry)', async () => {
    let clickedCount = 0;
    const fakeLocator = {
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockImplementation(async () => {
        clickedCount++;
      }),
    };

    const fakePage: SiiPageLike = {
      url: () => 'https://zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoRutClave.html',
      evaluate: vi.fn().mockImplementation(async (fn) => {
        if (typeof fn === 'function' && fn.toString().includes('form#myform')) {
          return {
            exists: true,
            actionUrl: 'https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi',
            method: 'post',
          };
        }
        return {
          bodyText: 'Su cuenta ha sido bloqueada por demasiados intentos.',
          hasVisibleCaptcha: false,
          hasMfaOrChallenge: false,
        };
      }),
      locator: vi.fn().mockReturnValue(fakeLocator),
    };

    await expect(
      authenticateTributaria({
        page: fakePage,
        rut: '11111111-1',
        password: 'secretpassword',
        guard,
      })
    ).rejects.toThrow('La cuenta ha sido bloqueada');

    expect(clickedCount).toBe(1); // One click max, no retry loop
    const state = guard.getState();
    expect(state.blockedUntil).toBeGreaterThan(Date.now());
    expect(Math.ceil((state.blockedUntil - Date.now()) / 1000)).toBeGreaterThanOrEqual(1790);
  });
});

describe('authenticateClaveUnica flow', () => {
  let tempDir: string;
  let guard: AuthAttemptGuard;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `guard-cu-${Date.now()}-${Math.random()}`);
    guard = new AuthAttemptGuard(tempDir);
  });

  it('rejects evil origin BEFORE any fill action is executed', async () => {
    const fakeLocator = {
      fill: vi.fn(),
      click: vi.fn(),
      selectOption: vi.fn(),
      first: vi.fn(),
      nth: vi.fn(),
    };

    const fakePage: SiiPageLike = {
      url: () => 'https://accounts.claveunica.gob.cl.evil/accounts/login',
      evaluate: vi.fn(),
      locator: vi.fn().mockReturnValue(fakeLocator),
    };

    await expect(
      authenticateClaveUnica({
        page: fakePage,
        rut: '11111111-1',
        password: 'secretpassword',
        guard,
      })
    ).rejects.toThrow(AppError);

    expect(fakeLocator.fill).not.toHaveBeenCalled();
    expect(fakeLocator.click).not.toHaveBeenCalled();
  });

  it('rejects embedded credentials in URL', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://user:pass@accounts.claveunica.gob.cl/accounts/login',
      evaluate: vi.fn(),
      locator: vi.fn(),
    };

    await expect(
      authenticateClaveUnica({
        page: fakePage,
        rut: '11111111-1',
        password: 'secretpassword',
        guard,
      })
    ).rejects.toThrow('El portal no se encuentra en el origen seguro permitido.');
  });

  it('assertClaveUnicaFormSecurity uses waitForSelector when available', async () => {
    const waitForSelectorSpy = vi.fn().mockResolvedValue(undefined);
    const fakePage: SiiPageLike = {
      url: () => 'https://accounts.claveunica.gob.cl/accounts/login/',
      evaluate: vi.fn().mockResolvedValue({
        exists: true,
        actionUrl: 'https://accounts.claveunica.gob.cl/accounts/login/',
        method: 'post',
      }),
      locator: vi.fn(),
      waitForSelector: waitForSelectorSpy,
    };

    await assertClaveUnicaFormSecurity(fakePage);
    expect(waitForSelectorSpy).toHaveBeenCalledWith('form#login-form', { timeout: 15000 });
  });

  it('assertClaveUnicaFormSecurity throws FORM_NOT_FOUND when form#login-form is missing', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://accounts.claveunica.gob.cl/accounts/login/',
      evaluate: vi.fn().mockResolvedValue({
        exists: false,
        actionUrl: '',
        method: '',
      }),
      locator: vi.fn(),
    };

    const abortController = new AbortController();
    abortController.abort(); // Immediately abort to avoid waiting 5s in poll

    await expect(
      assertClaveUnicaFormSecurity(fakePage, abortController.signal)
    ).rejects.toThrow();
  });

  it('rejects form with GET method in Clave Única (methodgetreject)', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://accounts.claveunica.gob.cl/accounts/login/',
      evaluate: vi.fn().mockResolvedValue({
        exists: true,
        actionUrl: 'https://accounts.claveunica.gob.cl/accounts/login/',
        method: 'get',
      }),
      locator: vi.fn(),
    };

    await expect(
      authenticateClaveUnica({
        page: fakePage,
        rut: '11111111-1',
        password: 'secretpassword',
        guard,
      })
    ).rejects.toThrow('El método del formulario de Clave Única no es POST seguro.');
  });

  it('rejects action pointing to untrusted path or domain', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://accounts.claveunica.gob.cl/accounts/login/',
      evaluate: vi.fn().mockResolvedValue({
        exists: true,
        actionUrl: 'https://accounts.claveunica.gob.cl/untrusted/action',
        method: 'post',
      }),
      locator: vi.fn(),
    };

    await expect(
      authenticateClaveUnica({
        page: fakePage,
        rut: '11111111-1',
        password: 'secretpassword',
        guard,
      })
    ).rejects.toThrow('La acción del formulario no apunta al destino oficial seguro permitido.');
  });

  it('never logs token or sensitive query params in error message (nologtokenURL)', async () => {
    const sensitiveUrl = 'https://accounts.claveunica.gob.cl.evil/accounts/login?next=/sii&token=CU_SECRET_TOKEN_XYZ';
    const fakePage: SiiPageLike = {
      url: () => sensitiveUrl,
      evaluate: vi.fn(),
      locator: vi.fn(),
    };

    let caughtError: AppError | undefined;
    try {
      await authenticateClaveUnica({
        page: fakePage,
        rut: '11111111-1',
        password: 'secretpassword',
        guard,
      });
    } catch (err) {
      caughtError = err as AppError;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError?.message).not.toContain('CU_SECRET_TOKEN_XYZ');
    expect(caughtError?.message).not.toContain('https://');
  });

  it('requires exact public fields #uname, #pword, #login-submit and fails if incomplete', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://accounts.claveunica.gob.cl/accounts/login/',
      evaluate: vi.fn().mockImplementation(async (fn) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('form#login-form')) {
            return {
              exists: true,
              actionUrl: 'https://accounts.claveunica.gob.cl/accounts/login/',
              method: 'post',
            };
          }
          // Simulate missing #pword field
          return {
            hasRun: true,
            hasPass: false,
            hasBtn: true,
          };
        }
        return { exists: true, actionUrl: 'https://accounts.claveunica.gob.cl/accounts/login/', method: 'post' };
      }),
      locator: vi.fn(),
    };

    await expect(
      authenticateClaveUnica({
        page: fakePage,
        rut: '11111111-1',
        password: 'secretpassword',
        guard,
      })
    ).rejects.toThrow('No fue posible ubicar los campos necesarios en el portal de Clave Única');
  });

  it('executes successful Clave Única flow with exactly one click (oneclick max)', async () => {
    let clickedCount = 0;
    let reservedBeforeClick = false;

    const originalReserve = guard.reserveAttempt.bind(guard);
    guard.reserveAttempt = async (sec) => {
      if (clickedCount === 0) {
        reservedBeforeClick = true;
      }
      return originalReserve(sec);
    };

    let urlValue = 'https://accounts.claveunica.gob.cl/accounts/login/';

    const fakeLocator = {
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockImplementation(async () => {
        clickedCount++;
        urlValue = 'https://www4.sii.cl/consdcvinternetui/#/index';
      }),
    };

    const fakePage: SiiPageLike = {
      url: () => urlValue,
      evaluate: vi.fn().mockImplementation(async (fn) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('form#login-form') && fnStr.includes('actionUrl')) {
            return {
              exists: true,
              actionUrl: 'https://accounts.claveunica.gob.cl/accounts/login/',
              method: 'post',
            };
          }
          if (fnStr.includes('hasRun')) {
            return {
              hasRun: true,
              hasPass: true,
              hasBtn: true,
            };
          }
          return {
            bodyText: 'Registro de Compras y Ventas',
            hasVisibleCaptcha: false,
            hasMfaOrChallenge: false,
          };
        }
        return {
          exists: true,
          actionUrl: 'https://accounts.claveunica.gob.cl/accounts/login/',
          method: 'post',
        };
      }),
      locator: vi.fn().mockReturnValue(fakeLocator),
    };

    await authenticateClaveUnica({
      page: fakePage,
      rut: '11111111-1',
      password: 'secretpassword',
      guard,
    });

    expect(reservedBeforeClick).toBe(true);
    expect(clickedCount).toBe(1);
    expect(fakeLocator.fill).toHaveBeenCalledTimes(2);
    expect(fakeLocator.fill).toHaveBeenNthCalledWith(1, '11.111.111-1');
    expect(fakeLocator.fill).toHaveBeenNthCalledWith(2, 'secretpassword');
  });

  it('fails fast if client validation flags control-error before submit', async () => {
    const fakeLocator = {
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn(),
    };

    const fakePage: SiiPageLike = {
      url: () => 'https://accounts.claveunica.gob.cl/accounts/login/',
      evaluate: vi.fn().mockImplementation(async (fn) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('form#login-form') && fnStr.includes('actionUrl')) {
            return {
              exists: true,
              actionUrl: 'https://accounts.claveunica.gob.cl/accounts/login/',
              method: 'post',
            };
          }
          if (fnStr.includes('hasRun')) {
            return { hasRun: true, hasPass: true, hasBtn: true };
          }
          if (fnStr.includes('hasClientError')) {
            return { hasClientError: true, btnDisabled: true };
          }
        }
        return { exists: true, actionUrl: 'https://accounts.claveunica.gob.cl/accounts/login/', method: 'post' };
      }),
      locator: vi.fn().mockReturnValue(fakeLocator),
    };

    await expect(
      authenticateClaveUnica({
        page: fakePage,
        rut: '11111111-1',
        password: 'bad',
        guard,
      })
    ).rejects.toThrow('El RUN o la clave ingresada no son válidos según la validación previa del portal.');

    // Ensure no click was performed
    expect(fakeLocator.click).not.toHaveBeenCalled();
  });

  it('fails with FORM_NOT_READY when submit button is disabled without reserving attempt or clicking (disabled no click no reserva)', async () => {
    const reserveSpy = vi.spyOn(guard, 'reserveAttempt');
    const fakeLocator = {
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
    };

    const fakePage: SiiPageLike = {
      url: () => 'https://accounts.claveunica.gob.cl/accounts/login/',
      evaluate: vi.fn().mockImplementation(async (fn) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('form#login-form') && fnStr.includes('actionUrl')) {
            return {
              exists: true,
              actionUrl: 'https://accounts.claveunica.gob.cl/accounts/login/',
              method: 'post',
            };
          }
          if (fnStr.includes('hasRun')) {
            return { hasRun: true, hasPass: true, hasBtn: true };
          }
          if (fnStr.includes('hasClientError')) {
            return {
              hasClientError: false,
              btnDisabled: true,
              isValid: true,
            };
          }
        }
        return { exists: true, actionUrl: 'https://accounts.claveunica.gob.cl/accounts/login/', method: 'post' };
      }),
      locator: vi.fn().mockReturnValue(fakeLocator),
    };

    let caughtError: AppError | undefined;
    try {
      await authenticateClaveUnica({
        page: fakePage,
        rut: '11111111-1',
        password: 'secretpassword',
        guard,
      });
    } catch (err) {
      caughtError = err as AppError;
    }

    expect(caughtError).toBeInstanceOf(AppError);
    expect(caughtError?.code).toBe('FORM_NOT_READY');
    expect(caughtError?.httpStatus).toBe(502);

    // Verify: SIN reserveAttempt ni click
    expect(reserveSpy).not.toHaveBeenCalled();
    expect(fakeLocator.click).not.toHaveBeenCalled();
    expect(guard.getState().nextAllowedAt).toBe(0);
  });

  it('fails with FORM_NOT_READY when form controls fail validity without reserving attempt or clicking', async () => {
    const reserveSpy = vi.spyOn(guard, 'reserveAttempt');
    const fakeLocator = {
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
    };

    const fakePage: SiiPageLike = {
      url: () => 'https://accounts.claveunica.gob.cl/accounts/login/',
      evaluate: vi.fn().mockImplementation(async (fn) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('form#login-form') && fnStr.includes('actionUrl')) {
            return {
              exists: true,
              actionUrl: 'https://accounts.claveunica.gob.cl/accounts/login/',
              method: 'post',
            };
          }
          if (fnStr.includes('hasRun')) {
            return { hasRun: true, hasPass: true, hasBtn: true };
          }
          if (fnStr.includes('hasClientError')) {
            return {
              hasClientError: false,
              btnDisabled: false,
              isValid: false,
            };
          }
        }
        return { exists: true, actionUrl: 'https://accounts.claveunica.gob.cl/accounts/login/', method: 'post' };
      }),
      locator: vi.fn().mockReturnValue(fakeLocator),
    };

    let caughtError: AppError | undefined;
    try {
      await authenticateClaveUnica({
        page: fakePage,
        rut: '11111111-1',
        password: 'secretpassword',
        guard,
      });
    } catch (err) {
      caughtError = err as AppError;
    }

    expect(caughtError).toBeInstanceOf(AppError);
    expect(caughtError?.code).toBe('FORM_NOT_READY');
    expect(caughtError?.httpStatus).toBe(502);
    expect(reserveSpy).not.toHaveBeenCalled();
    expect(fakeLocator.click).not.toHaveBeenCalled();
    expect(guard.getState().nextAllowedAt).toBe(0);
  });

  it('returns safe return diagnostic and succeeds when redirecting back to zeusr.sii.cl callback', async () => {
    let urlValue = 'https://accounts.claveunica.gob.cl/accounts/login/';
    const fakeLocator = {
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockImplementation(async () => {
        urlValue = 'https://zeusr.sii.cl/cgi_AUT2000/CAutClaveUnica.cgi?TOKEN=XYZ';
      }),
    };

    const fakePage: SiiPageLike = {
      url: () => urlValue,
      evaluate: vi.fn().mockImplementation(async (fn) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('form#login-form') && fnStr.includes('actionUrl')) {
            return {
              exists: true,
              actionUrl: 'https://accounts.claveunica.gob.cl/accounts/login/',
              method: 'post',
            };
          }
          if (fnStr.includes('hasRun')) {
            return { hasRun: true, hasPass: true, hasBtn: true };
          }
        }
        return { exists: true, actionUrl: 'https://accounts.claveunica.gob.cl/accounts/login/', method: 'post' };
      }),
      locator: vi.fn().mockReturnValue(fakeLocator),
    };

    let reportedDiag: unknown;
    const result = await authenticateClaveUnica({
      page: fakePage,
      rut: '11111111-1',
      password: 'secretpassword',
      guard,
      onReturnDiagnostic: (diag) => {
        reportedDiag = diag;
      },
    });

    expect(result.diagnosticoRetorno).toEqual({
      formularioSigue: false,
      origen: 'https://zeusr.sii.cl',
      ruta: '/cgi_AUT2000/CAutClaveUnica.cgi',
      codigo: 'RETURNED_TO_SII',
    });
    expect(reportedDiag).toEqual(result.diagnosticoRetorno);
    // Ensure no token or query params leaked in diagnostic
    expect(JSON.stringify(result.diagnosticoRetorno)).not.toContain('TOKEN');
  });

  it('triggers onReturnDiagnostic with formRemains=true when credentials are rejected', async () => {
    const urlValue = 'https://accounts.claveunica.gob.cl/accounts/login/?next=/sii';
    const fakeLocator = {
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
    };

    const fakePage: SiiPageLike = {
      url: () => urlValue,
      evaluate: vi.fn().mockImplementation(async (fn) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('form#login-form') && fnStr.includes('actionUrl')) {
            return {
              exists: true,
              actionUrl: 'https://accounts.claveunica.gob.cl/accounts/login/',
              method: 'post',
            };
          }
          if (fnStr.includes('hasRun')) {
            return { hasRun: true, hasPass: true, hasBtn: true };
          }
          if (fnStr.includes('formRemains')) {
            return {
              formRemains: true,
              bodyText: 'El RUN o la clave ingresada no son correctos',
              hasVisibleCaptcha: false,
              hasMfaOrChallenge: false,
            };
          }
        }
        return { exists: true, actionUrl: 'https://accounts.claveunica.gob.cl/accounts/login/', method: 'post' };
      }),
      locator: vi.fn().mockReturnValue(fakeLocator),
    };

    let capturedDiag: unknown;
    await expect(
      authenticateClaveUnica({
        page: fakePage,
        rut: '11111111-1',
        password: 'wrongpassword',
        guard,
        onReturnDiagnostic: (diag) => {
          capturedDiag = diag;
        },
      })
    ).rejects.toThrow(AppError);

    expect(capturedDiag).toEqual({
      formularioSigue: true,
      origen: 'https://accounts.claveunica.gob.cl',
      ruta: '/accounts/login/',
      codigo: 'INVALID_CREDENTIALS',
    });
  });
});

describe('Anti-regresión: funciones de autenticación evaluadas en navegador (page.evaluate) son JS puro serializable', () => {
  const authFiles = [
    {
      filePath: fileURLToPath(new URL('../src/infrastructure/sii/claveUnicaAuth.ts', import.meta.url)),
      name: 'claveUnicaAuth.ts',
      expectedEvaluated: [
        'evaluateClaveUnicaFormMeta',
        'evaluateClaveUnicaFormFields',
        'evaluateClaveUnicaFormValidation',
        'evaluateClaveUnicaPostSubmitState',
      ],
      runtimeFns: {
        evaluateClaveUnicaFormMeta,
        evaluateClaveUnicaFormFields,
        evaluateClaveUnicaFormValidation,
        evaluateClaveUnicaPostSubmitState,
      } as Record<string, () => unknown>,
    },
    {
      filePath: fileURLToPath(new URL('../src/infrastructure/sii/tributariaAuth.ts', import.meta.url)),
      name: 'tributariaAuth.ts',
      expectedEvaluated: ['evaluateTributariaFormMeta'],
      runtimeFns: {
        evaluateTributariaFormMeta,
      } as Record<string, () => unknown>,
    },
    {
      filePath: fileURLToPath(new URL('../src/infrastructure/sii/siiPage.ts', import.meta.url)),
      name: 'siiPage.ts',
      expectedEvaluated: ['evaluateAuthPollingSnapshot'],
      runtimeFns: {
        evaluateAuthPollingSnapshot,
      } as Record<string, () => unknown>,
    },
  ];

  for (const fileInfo of authFiles) {
    describe(`Archivo ${fileInfo.name}`, () => {
      const sourceText = fs.readFileSync(fileInfo.filePath, 'utf8');
      const sourceFile = ts.createSourceFile(fileInfo.name, sourceText, ts.ScriptTarget.Latest, true);

      const evaluatedFnNames = new Set<string>();
      function findEvaluateCalls(node: ts.Node) {
        if (ts.isCallExpression(node)) {
          const expr = node.expression;
          if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'evaluate') {
            const firstArg = node.arguments[0];
            if (firstArg && ts.isIdentifier(firstArg)) {
              evaluatedFnNames.add(firstArg.text);
            }
          }
        }
        ts.forEachChild(node, findEvaluateCalls);
      }
      findEvaluateCalls(sourceFile);

      it(`detecta todas las funciones evaluadas requeridas en ${fileInfo.name}`, () => {
        for (const fn of fileInfo.expectedEvaluated) {
          expect(evaluatedFnNames.has(fn), `Debe detectar page.evaluate(${fn})`).toBe(true);
        }
      });

      function getFunctionDeclaration(name: string): ts.FunctionDeclaration | null {
        let found: ts.FunctionDeclaration | null = null;
        function walk(node: ts.Node) {
          if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
            found = node;
            return;
          }
          ts.forEachChild(node, walk);
        }
        walk(sourceFile);
        return found;
      }

      it(`cada función evaluada está exportada en ${fileInfo.name}`, () => {
        for (const fnName of evaluatedFnNames) {
          const decl = getFunctionDeclaration(fnName);
          expect(decl, `Función ${fnName} debe existir en ${fileInfo.name}`).not.toBeNull();
          const hasExport = decl?.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
          expect(hasExport, `Función ${fnName} debe estar exportada`).toBe(true);
        }
      });

      it(`el cuerpo crudo de cada función evaluada en ${fileInfo.name} pasa new Function sin lanzar`, () => {
        for (const fnName of evaluatedFnNames) {
          const decl = getFunctionDeclaration(fnName);
          expect(decl?.body, `Función ${fnName} debe tener cuerpo`).toBeDefined();
          const statementsText = decl!.body!.statements.map((s) => s.getText(sourceFile)).join('\n');

          expect(() => {
            try {
              new Function(statementsText);
            } catch (err: unknown) {
              throw new Error(
                `Función evaluada "${fnName}" falló en new Function() con cuerpo crudo de ${fileInfo.name}:\n` +
                `${(err as Error).message}\n` +
                `Cuerpo:\n${statementsText.slice(0, 300)}...`
              );
            }
          }).not.toThrow();
        }
      });

      it(`cada función evaluada exportada en runtime pasa new Function(fn.toString()) sin lanzar en ${fileInfo.name}`, () => {
        for (const fnName of evaluatedFnNames) {
          const fn = fileInfo.runtimeFns[fnName];
          expect(typeof fn, `Función ${fnName} debe existir en runtime`).toBe('function');
          const fnStr = fn!.toString();
          expect(() => {
            new Function('return (' + fnStr + ')')();
          }).not.toThrow();
        }
      });

      const BANNED_BROWSER_IDENTIFIERS = [
        '__name',
        '__publicField',
        '__defProp',
        'require',
        'exports',
        'module',
      ];

      it(`ninguna función evaluada contiene identificadores prohibidos de bundler/node (__name, __publicField, __defProp, require, exports, module) en ${fileInfo.name}`, () => {
        for (const fnName of evaluatedFnNames) {
          const fn = fileInfo.runtimeFns[fnName];
          const fnStr = fn!.toString();
          for (const banned of BANNED_BROWSER_IDENTIFIERS) {
            const regex = new RegExp(`\\b${banned}\\b`);
            expect(
              regex.test(fnStr),
              `Función evaluada "${fnName}" en ${fileInfo.name} no debe contener "${banned}" en su serialización toString():\n${fnStr.slice(0, 300)}`
            ).toBe(false);
          }
        }
      });

      it(`cada función evaluada se ejecuta exitosamente en un sandbox VM aislado sin identificadores externos en ${fileInfo.name}`, () => {
        const mockDoc = {
          querySelectorAll: () => [],
          querySelector: () => null,
          body: { innerText: '', textContent: '' },
        };
        const mockWin = {
          getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
          Event: class Event {},
          KeyboardEvent: class KeyboardEvent {},
        };

        for (const fnName of evaluatedFnNames) {
          const fn = fileInfo.runtimeFns[fnName];
          const fnStr = fn!.toString();

          const sandbox = {
            document: mockDoc,
            window: mockWin,
            Array,
            String,
            Number,
            Boolean,
            RegExp,
            Event: class Event {},
            KeyboardEvent: class KeyboardEvent {},
          };
          const context = vm.createContext(sandbox);
          const compiled = vm.runInContext(`(${fnStr})`, context);
          expect(typeof compiled, `Función ${fnName} compilada en sandbox VM`).toBe('function');
          expect(() => {
            compiled();
          }, `Función ${fnName} ejecutada en sandbox VM`).not.toThrow();
        }
      });
    });
  }

  it('control negativo: verifica que identificadores prohibidos como __name son detectados y fallan la ejecución en sandbox VM', () => {
    const faultyFunctionSrc = `function faultyEvaluation() {
      function internalHelper() { return true; }
      __name(internalHelper, "internalHelper");
      return internalHelper();
    }`;

    const BANNED = ['__name', '__publicField', '__defProp', 'require', 'exports', 'module'];
    const detectedBanned = BANNED.filter((b) =>
      new RegExp(`\\b${b}\\b`).test(faultyFunctionSrc)
    );
    expect(detectedBanned).toEqual(['__name']);

    const sandbox = {
      document: { querySelectorAll: () => [], querySelector: () => null },
      window: {},
    };
    const context = vm.createContext(sandbox);
    const compiled = vm.runInContext(`(${faultyFunctionSrc})`, context);
    expect(() => {
      compiled();
    }).toThrow(/__name is not defined/);

    try {
      compiled();
      expect.fail('Debe fallar con ReferenceError');
    } catch (err: unknown) {
      expect((err as Error).name).toBe('ReferenceError');
      expect((err as Error).message).toContain('__name is not defined');
    }
  });
});


