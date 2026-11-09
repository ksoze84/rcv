import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { StagehandRcvProvider } from '../src/infrastructure/sii/stagehandRcvProvider.js';
import { AuthAttemptGuard } from '../src/infrastructure/sii/authAttemptGuard.js';
import { AppConfig } from '../src/infrastructure/config/environment.js';
import { BrowserSession } from '../src/infrastructure/sii/browserSession.js';
import { AppError } from '../src/domain/errors.js';

describe('StagehandRcvProvider', () => {
  let tempDir: string;
  let guard: AuthAttemptGuard;
  let config: AppConfig;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `provider-test-${Date.now()}-${Math.random()}`);
    guard = new AuthAttemptGuard(tempDir);
    config = {
      port: 3001,
      host: '127.0.0.1',
      localStateDir: tempDir,
      headless: true,
      operationTimeoutMs: 60000,
      maxCsvBytes: 10 * 1024 * 1024,
      maxCsvRows: 20000,
    };
  });

  it('instantiates cleanly and respects close idempotency', async () => {
    const provider = new StagehandRcvProvider(config, guard);
    await expect(provider.close()).resolves.not.toThrow();
    await expect(provider.close()).resolves.not.toThrow();
  });

  it('rejects fetch if signal is already aborted', async () => {
    const provider = new StagehandRcvProvider(config, guard);
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.fetch(
        { rut: '11111111-1', password: 'pass', authMode: 'tributaria' },
        controller.signal
      )
    ).rejects.toThrow();
  });

  it('rejects fetch if provider is closed', async () => {
    const provider = new StagehandRcvProvider(config, guard);
    await provider.close();

    const controller = new AbortController();
    await expect(
      provider.fetch(
        { rut: '11111111-1', password: 'pass', authMode: 'tributaria' },
        controller.signal
      )
    ).rejects.toThrow(AppError);
  });

  it('orchestrates fetch with mocked session and verified identity', async () => {
    const fakeLocator = {
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      selectOption: vi.fn().mockResolvedValue(undefined),
      first: vi.fn().mockReturnThis(),
      nth: vi.fn().mockReturnThis(),
    };

    const fakePage = {
      url: vi.fn().mockReturnValue('https://www4.sii.cl/consdcvinternetui/#/index'),
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockImplementation(async (fn: unknown, arg: unknown) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('myRut') || fnStr.includes('cleanCandidates')) {
            return { headerText: 'Contribuyente: 11.111.111-1' };
          }
          if (fnStr.includes('hasConsultarButton') || fnStr.includes('comprasTabFound')) {
            return {
              hasConsultarButton: true,
              hasTabs: true,
              comprasTabFound: true,
              ventasTabFound: true,
              tableCount: 1,
              hasNoMovementsMessage: true,
              periodConfirmed: true,
            };
          }
          if (fnStr.includes('selectCount')) {
            return {
              selectCount: 2,
              yearSelectIndex: 0,
              monthSelectIndex: 1,
              yearValue: '2026',
              monthValue: '02',
            };
          }
          if (fnStr.includes('noSeEncontraron') || fnStr.includes('noMovementsPatterns')) {
            return { hasNoMovements: true, hasDownloadButton: false, periodConfirmed: true, activeTabConfirmed: true };
          }
        }
        if (arg === 'Compras' || arg === 'Ventas') {
          return true;
        }
        return false;
      }),
      locator: vi.fn().mockReturnValue(fakeLocator),
    };

    const fakeSession = {
      page: fakePage,
      downloadsPath: tempDir,
      tempRoot: tempDir,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserSession;

    const startSpy = vi.spyOn(BrowserSession, 'start').mockResolvedValue(fakeSession);

    const provider = new StagehandRcvProvider(config, guard);
    const controller = new AbortController();

    const result = await provider.fetch(
      { rut: '11111111-1', password: 'pass', authMode: 'tributaria' },
      controller.signal
    );

    expect(result.compras.status).toBe('empty');
    expect(result.ventas.status).toBe('empty');
    expect(fakePage.goto).toHaveBeenCalled();

    await provider.close();
    expect(fakeSession.close).toHaveBeenCalled();

    startSpy.mockRestore();
  }, 15000);

  it('sanitiza errores genéricos en captureRcvTab evitando filtrar URLs, tokens o mensajes arbitrarios', async () => {
    const fakeLocator = {
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      selectOption: vi.fn().mockResolvedValue(undefined),
      first: vi.fn().mockReturnThis(),
      nth: vi.fn().mockReturnThis(),
    };

    const fakePage = {
      url: vi.fn().mockReturnValue('https://www4.sii.cl/consdcvinternetui/#/index'),
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockImplementation(async (fn: unknown, arg: unknown) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('myRut') || fnStr.includes('cleanCandidates')) {
            return { headerText: 'Contribuyente: 11.111.111-1' };
          }
          if (fnStr.includes('selectCount') || fnStr.includes('hasConsultarButton') || fnStr.includes('comprasTabFound')) {
            throw new Error('Network failure to https://zeusr.sii.cl/auth?token=LEAKED_SECRET_TOKEN_999');
          }
        }
        if (arg === 'Compras' || arg === 'Ventas') {
          return true;
        }
        return false;
      }),
      locator: vi.fn().mockReturnValue(fakeLocator),
    };

    const fakeSession = {
      page: fakePage,
      downloadsPath: tempDir,
      tempRoot: tempDir,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserSession;

    const startSpy = vi.spyOn(BrowserSession, 'start').mockResolvedValue(fakeSession);

    const provider = new StagehandRcvProvider(config, guard);
    const controller = new AbortController();

    const result = await provider.fetch(
      { rut: '11111111-1', password: 'pass', authMode: 'tributaria' },
      controller.signal
    );

    expect(result.compras.status).toBe('error');
    if (result.compras.status === 'error') {
      expect(result.compras.error.code).toBe('EVALUATE_FAILED');
      expect(result.compras.error.stage).toBe('period_selection');
      expect(result.compras.error.message).not.toContain('LEAKED_SECRET_TOKEN_999');
      expect(result.compras.error.message).not.toContain('https://');
    }

    expect(result.ventas.status).toBe('error');
    if (result.ventas.status === 'error') {
      expect(result.ventas.error.code).toBe('EVALUATE_FAILED');
      expect(result.ventas.error.stage).toBe('period_selection');
      expect(result.ventas.error.message).not.toContain('LEAKED_SECRET_TOKEN_999');
      expect(result.ventas.error.message).not.toContain('https://');
    }

    await provider.close();
    startSpy.mockRestore();
  }, 15000);

  it('distingue falta de boton de descarga retornando RCV_DOWNLOAD_UNAVAILABLE (fail-closed)', async () => {
    const fakeLocator = {
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      selectOption: vi.fn().mockResolvedValue(undefined),
      first: vi.fn().mockReturnThis(),
      nth: vi.fn().mockReturnThis(),
    };

    const fakePage = {
      url: vi.fn().mockReturnValue('https://www4.sii.cl/consdcvinternetui/#/index'),
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockImplementation(async (fn: unknown, arg: unknown) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('myRut') || fnStr.includes('cleanCandidates')) {
            return { headerText: 'Contribuyente: 11.111.111-1' };
          }
          if (fnStr.includes('hasConsultarButton') || fnStr.includes('comprasTabFound')) {
            return {
              hasConsultarButton: true,
              hasTabs: true,
              comprasTabFound: true,
              ventasTabFound: true,
              tableCount: 1,
              hasNoMovementsMessage: false,
              periodConfirmed: true,
            };
          }
          if (fnStr.includes('selectCount')) {
            return {
              selectCount: 2,
              yearSelectIndex: 0,
              monthSelectIndex: 1,
              yearValue: '2026',
              monthValue: '02',
            };
          }
          if (fnStr.includes('noMovementsPatterns')) {
            // No hay mensaje explícito de sin movimientos Y no hay botón de descarga
            return { hasNoMovements: false, hasDownloadButton: false, periodConfirmed: true, activeTabConfirmed: true };
          }
        }
        if (arg === 'Compras' || arg === 'Ventas') {
          return true;
        }
        return false;
      }),
      locator: vi.fn().mockReturnValue(fakeLocator),
    };

    const fakeSession = {
      page: fakePage,
      downloadsPath: tempDir,
      tempRoot: tempDir,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserSession;

    const startSpy = vi.spyOn(BrowserSession, 'start').mockResolvedValue(fakeSession);

    const provider = new StagehandRcvProvider(config, guard);
    const controller = new AbortController();

    const result = await provider.fetch(
      { rut: '11111111-1', password: 'pass', authMode: 'tributaria' },
      controller.signal
    );

    // Debe distinguir la ausencia del botón de descarga (RCV_DOWNLOAD_UNAVAILABLE) en vez de CAPTURE_FAILED o empty
    expect(result.compras.status).toBe('error');
    if (result.compras.status === 'error') {
      expect(result.compras.error.code).toBe('RCV_DOWNLOAD_UNAVAILABLE');
      expect(result.compras.error.message).toContain('No se encuentra disponible la opción de descarga de detalles');
      expect(result.compras.error.tabDiagnostic).toBeDefined();
      expect(result.compras.error.tabDiagnostic?.detalleButtonFound).toBe(false);
    }

    expect(result.ventas.status).toBe('error');
    if (result.ventas.status === 'error') {
      expect(result.ventas.error.code).toBe('RCV_DOWNLOAD_UNAVAILABLE');
    }

    await provider.close();
    startSpy.mockRestore();
  }, 15000);

  it('retorna status empty en compras y ventas cuando el portal muestra los mensajes reales "No hay información de Registro." y "No hay información de Ventas."', async () => {
    const fakeLocator = {
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      selectOption: vi.fn().mockResolvedValue(undefined),
      first: vi.fn().mockReturnThis(),
      nth: vi.fn().mockReturnThis(),
    };

    const fakePage = {
      url: vi.fn().mockReturnValue('https://www4.sii.cl/consdcvinternetui/#/index'),
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockImplementation(async (fn: unknown, arg: unknown) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('myRut') || fnStr.includes('cleanCandidates')) {
            return { headerText: 'Contribuyente: 11.111.111-1' };
          }
          if (fnStr.includes('hasConsultarButton') || fnStr.includes('comprasTabFound')) {
            return {
              hasConsultarButton: true,
              hasTabs: true,
              comprasTabFound: true,
              ventasTabFound: true,
              tableCount: 0,
              hasNoMovementsMessage: true,
              matchedNoMovementsPattern: 'no hay informacion de registro',
              periodConfirmed: true,
            };
          }
          if (fnStr.includes('selectCount')) {
            return {
              selectCount: 2,
              yearSelectIndex: 0,
              monthSelectIndex: 1,
              yearValue: '2026',
              monthValue: '02',
            };
          }
          if (fnStr.includes('noMovementsPatterns')) {
            return {
              hasNoMovements: true,
              hasDownloadButton: false,
              periodConfirmed: true,
              activeTabConfirmed: true,
              noMovementsPatternFound: true,
            };
          }
        }
        if (arg === 'Compras' || arg === 'Ventas') {
          return true;
        }
        return false;
      }),
      locator: vi.fn().mockReturnValue(fakeLocator),
    };

    const fakeSession = {
      page: fakePage,
      downloadsPath: tempDir,
      tempRoot: tempDir,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserSession;

    const startSpy = vi.spyOn(BrowserSession, 'start').mockResolvedValue(fakeSession);

    const provider = new StagehandRcvProvider(config, guard);
    const controller = new AbortController();

    const result = await provider.fetch(
      { rut: '11111111-1', password: 'pass', authMode: 'tributaria' },
      controller.signal
    );

    expect(result.compras.status).toBe('empty');
    expect(result.ventas.status).toBe('empty');

    await provider.close();
    startSpy.mockRestore();
  }, 15000);

  it('distingue timeout retornando TIMEOUT en vez de CAPTURE_FAILED', async () => {
    const timeoutErr = new Error('Timeout 30000ms exceeded.');
    timeoutErr.name = 'TimeoutError';

    const fakeLocator = {
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockRejectedValue(timeoutErr),
      selectOption: vi.fn().mockResolvedValue(undefined),
      first: vi.fn().mockReturnThis(),
      nth: vi.fn().mockReturnThis(),
    };

    const fakePage = {
      url: vi.fn().mockReturnValue('https://www4.sii.cl/consdcvinternetui/#/index'),
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockImplementation(async (fn: unknown, arg: unknown) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('myRut') || fnStr.includes('cleanCandidates')) {
            return { headerText: 'Contribuyente: 11.111.111-1' };
          }
          if (fnStr.includes('hasConsultarButton') || fnStr.includes('comprasTabFound')) {
            return {
              hasConsultarButton: true,
              hasTabs: true,
              comprasTabFound: true,
              ventasTabFound: true,
              tableCount: 1,
              hasNoMovementsMessage: false,
              periodConfirmed: true,
            };
          }
          if (fnStr.includes('selectCount')) {
            return {
              selectCount: 2,
              yearSelectIndex: 0,
              monthSelectIndex: 1,
              yearValue: '2026',
              monthValue: '02',
            };
          }
          if (fnStr.includes('noMovementsPatterns')) {
            return { hasNoMovements: false, hasDownloadButton: true, periodConfirmed: true, activeTabConfirmed: true };
          }
          if (fnStr.includes('consultar') || fnStr.includes('buttons.find')) {
            return true;
          }
          if (fnStr.includes('descargar detalles') || fnStr.includes('downloadBtn')) {
            const err = new Error('Timeout 30000ms exceeded.');
            err.name = 'TimeoutError';
            throw err;
          }
        }
        if (arg === 'Compras' || arg === 'Ventas') {
          return true;
        }
        return false;
      }),
      locator: vi.fn().mockReturnValue(fakeLocator),
    };

    const fakeSession = {
      page: fakePage,
      downloadsPath: tempDir,
      tempRoot: tempDir,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserSession;

    const startSpy = vi.spyOn(BrowserSession, 'start').mockResolvedValue(fakeSession);

    const provider = new StagehandRcvProvider(config, guard);
    const controller = new AbortController();

    const result = await provider.fetch(
      { rut: '11111111-1', password: 'pass', authMode: 'tributaria' },
      controller.signal
    );

    // Debe distinguir timeout retornando TIMEOUT con stage correspondiente
    expect(result.compras.status).toBe('error');
    if (result.compras.status === 'error') {
      expect(result.compras.error.code).toBe('TIMEOUT');
      expect(result.compras.error.stage).toBe('download_trigger');
    }

    await provider.close();
    startSpy.mockRestore();
  }, 15000);

  it('clasifica PERIOD_SELECT_FAILED cuando los controles de período no existen', async () => {
    const fakeLocator = {
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      selectOption: vi.fn().mockResolvedValue(undefined),
      first: vi.fn().mockReturnThis(),
      nth: vi.fn().mockReturnThis(),
    };

    const fakePage = {
      url: vi.fn().mockReturnValue('https://www4.sii.cl/consdcvinternetui/#/index'),
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockImplementation(async (fn: unknown, arg?: unknown) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('myRut') || fnStr.includes('cleanCandidates')) {
            return { headerText: 'Contribuyente: 11.111.111-1' };
          }
          if (fnStr.includes('hasConsultarButton') || fnStr.includes('comprasTabFound')) {
            return {
              hasConsultarButton: false,
              hasTabs: false,
              comprasTabFound: false,
              ventasTabFound: false,
              tableCount: 0,
              hasNoMovementsMessage: false,
              periodConfirmed: false,
            };
          }
          if (fnStr.includes('selectCount')) {
            // Cero selectores en el DOM
            return {
              selectCount: 0,
              yearSelectIndex: -1,
              monthSelectIndex: -1,
              yearValue: '',
              monthValue: '',
            };
          }
        }
        if (arg === 'Compras' || arg === 'Ventas') {
          return true;
        }
        return false;
      }),
      locator: vi.fn().mockReturnValue(fakeLocator),
    };

    const fakeSession = {
      page: fakePage,
      downloadsPath: tempDir,
      tempRoot: tempDir,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserSession;

    const startSpy = vi.spyOn(BrowserSession, 'start').mockResolvedValue(fakeSession);
    const provider = new StagehandRcvProvider(config, guard);
    const controller = new AbortController();

    const result = await provider.fetch(
      { rut: '11111111-1', password: 'pass', authMode: 'tributaria' },
      controller.signal
    );

    expect(result.compras.status).toBe('error');
    if (result.compras.status === 'error') {
      expect(result.compras.error.code).toBe('PERIOD_SELECT_FAILED');
      expect(result.compras.error.stage).toBe('period_selection');
      expect(result.compras.error.message).not.toContain('http');
    }

    await provider.close();
    startSpy.mockRestore();
  }, 15000);

  it('clasifica QUERY_BUTTON_MISSING cuando el botón Consultar no está disponible', async () => {
    const fakeLocator = {
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockRejectedValue(new Error('Element not found')),
      selectOption: vi.fn().mockResolvedValue(undefined),
      first: vi.fn().mockReturnThis(),
      nth: vi.fn().mockReturnThis(),
    };

    const fakePage = {
      url: vi.fn().mockReturnValue('https://www4.sii.cl/consdcvinternetui/#/index'),
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockImplementation(async (fn: unknown, arg?: unknown) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('myRut') || fnStr.includes('cleanCandidates')) {
            return { headerText: 'Contribuyente: 11.111.111-1' };
          }
          if (fnStr.includes('hasConsultarButton') || fnStr.includes('comprasTabFound')) {
            return {
              hasConsultarButton: false,
              hasTabs: false,
              comprasTabFound: false,
              ventasTabFound: false,
              tableCount: 0,
              hasNoMovementsMessage: false,
              periodConfirmed: false,
            };
          }
          if (fnStr.includes('selectCount')) {
            return {
              selectCount: 2,
              yearSelectIndex: 0,
              monthSelectIndex: 1,
              yearValue: '2026',
              monthValue: '02',
            };
          }
          if (fnStr.includes('triggerAngularSelect')) {
            return { angularAvailable: true, angularError: false };
          }
          if (fnStr.includes('consultar') || fnStr.includes('buttons.find')) {
            // Botón Consultar no existe
            return false;
          }
        }
        if (arg === 'Compras' || arg === 'Ventas') {
          return true;
        }
        return false;
      }),
      locator: vi.fn().mockReturnValue(fakeLocator),
    };

    const fakeSession = {
      page: fakePage,
      downloadsPath: tempDir,
      tempRoot: tempDir,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserSession;

    const startSpy = vi.spyOn(BrowserSession, 'start').mockResolvedValue(fakeSession);
    const provider = new StagehandRcvProvider(config, guard);
    const controller = new AbortController();

    const result = await provider.fetch(
      { rut: '11111111-1', password: 'pass', authMode: 'tributaria' },
      controller.signal
    );

    expect(result.compras.status).toBe('error');
    if (result.compras.status === 'error') {
      expect(result.compras.error.code).toBe('QUERY_BUTTON_MISSING');
      expect(result.compras.error.stage).toBe('query_button');
    }

    await provider.close();
    startSpy.mockRestore();
  }, 15000);

  it('clasifica RESULTS_NOT_RENDERED cuando los resultados no cargan tras consultar', async () => {
    const fakeLocator = {
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      selectOption: vi.fn().mockResolvedValue(undefined),
      first: vi.fn().mockReturnThis(),
      nth: vi.fn().mockReturnThis(),
    };

    const fakePage = {
      url: vi.fn().mockReturnValue('https://www4.sii.cl/consdcvinternetui/#/index'),
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockImplementation(async (fn: unknown, arg?: unknown) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('myRut') || fnStr.includes('cleanCandidates')) {
            return { headerText: 'Contribuyente: 11.111.111-1' };
          }
          if (fnStr.includes('selectCount')) {
            return {
              selectCount: 2,
              yearSelectIndex: 0,
              monthSelectIndex: 1,
              yearValue: '2026',
              monthValue: '02',
            };
          }
          if (fnStr.includes('hasConsultarButton') || fnStr.includes('comprasTabFound')) {
            // Portal muestra mensaje de error tras consultar
            return {
              hasConsultarButton: true,
              hasTabs: false,
              comprasTabFound: false,
              ventasTabFound: false,
              tableCount: 0,
              hasNoMovementsMessage: false,
              hasErrorMessage: true,
              errorMessage: 'Error en servicio RCV',
              periodConfirmed: true,
            };
          }
          if (fnStr.includes('triggerAngularSelect')) {
            return { angularAvailable: true, angularError: false };
          }
          if (fnStr.includes('consultar') || fnStr.includes('buttons.find')) {
            return true; // Click consultar exitoso
          }
        }
        if (arg === 'Compras' || arg === 'Ventas') {
          return true;
        }
        return false;
      }),
      locator: vi.fn().mockReturnValue(fakeLocator),
    };

    const fakeSession = {
      page: fakePage,
      downloadsPath: tempDir,
      tempRoot: tempDir,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserSession;

    const startSpy = vi.spyOn(BrowserSession, 'start').mockResolvedValue(fakeSession);
    const provider = new StagehandRcvProvider(config, guard);
    const controller = new AbortController();

    // Timeout corto en la operación externa para validar
    const result = await provider.fetch(
      { rut: '11111111-1', password: 'pass', authMode: 'tributaria' },
      controller.signal
    );

    expect(result.compras.status).toBe('error');
    if (result.compras.status === 'error') {
      expect(result.compras.error.code).toBe('RESULTS_NOT_RENDERED');
      expect(result.compras.error.stage).toBe('results_render');
    }

    await provider.close();
    startSpy.mockRestore();
  }, 25000);

  it('clasifica TAB_NOT_FOUND cuando la pestaña solicitada no existe tras renderizar', async () => {
    const fakeLocator = {
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      selectOption: vi.fn().mockResolvedValue(undefined),
      first: vi.fn().mockReturnThis(),
      nth: vi.fn().mockReturnThis(),
    };

    const fakePage = {
      url: vi.fn().mockReturnValue('https://www4.sii.cl/consdcvinternetui/#/index'),
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockImplementation(async (fn: unknown) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('myRut') || fnStr.includes('cleanCandidates')) {
            return { headerText: 'Contribuyente: 11.111.111-1' };
          }
          if (fnStr.includes('hasConsultarButton') || fnStr.includes('comprasTabFound')) {
            return {
              hasConsultarButton: true,
              hasTabs: true,
              comprasTabFound: true,
              ventasTabFound: true,
              tableCount: 1,
              hasNoMovementsMessage: false,
              periodConfirmed: true,
            };
          }
          if (fnStr.includes('selectCount')) {
            return {
              selectCount: 2,
              yearSelectIndex: 0,
              monthSelectIndex: 1,
              yearValue: '2026',
              monthValue: '02',
            };
          }
          if (fnStr.includes('targetLower') && fnStr.includes('oppositeLower')) {
            // Click en la pestaña retorna false (no encontrada)
            return false;
          }
        }
        return false;
      }),
      locator: vi.fn().mockReturnValue(fakeLocator),
    };

    const fakeSession = {
      page: fakePage,
      downloadsPath: tempDir,
      tempRoot: tempDir,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserSession;

    const startSpy = vi.spyOn(BrowserSession, 'start').mockResolvedValue(fakeSession);
    const provider = new StagehandRcvProvider(config, guard);
    const controller = new AbortController();

    const result = await provider.fetch(
      { rut: '11111111-1', password: 'pass', authMode: 'tributaria' },
      controller.signal
    );

    expect(result.compras.status).toBe('error');
    if (result.compras.status === 'error') {
      expect(result.compras.error.code).toBe('TAB_NOT_FOUND');
      expect(result.compras.error.stage).toBe('tab_selection');
    }

    await provider.close();
    startSpy.mockRestore();
  }, 15000);

  it('clasifica DOWNLOAD_TRIGGER_FAILED cuando el botón de descarga no puede ser detonado', async () => {
    const fakeLocator = {
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      selectOption: vi.fn().mockResolvedValue(undefined),
      first: vi.fn().mockReturnThis(),
      nth: vi.fn().mockReturnThis(),
    };

    const fakePage = {
      url: vi.fn().mockReturnValue('https://www4.sii.cl/consdcvinternetui/#/index'),
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockImplementation(async (fn: unknown, arg: unknown) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('myRut') || fnStr.includes('cleanCandidates')) {
            return { headerText: 'Contribuyente: 11.111.111-1' };
          }
          if (fnStr.includes('hasConsultarButton') || fnStr.includes('comprasTabFound')) {
            return {
              hasConsultarButton: true,
              hasTabs: true,
              comprasTabFound: true,
              ventasTabFound: true,
              tableCount: 1,
              hasNoMovementsMessage: false,
              periodConfirmed: true,
            };
          }
          if (fnStr.includes('selectCount')) {
            return {
              selectCount: 2,
              yearSelectIndex: 0,
              monthSelectIndex: 1,
              yearValue: '2026',
              monthValue: '02',
            };
          }
          if (fnStr.includes('noMovementsPatterns')) {
            return { hasNoMovements: false, hasDownloadButton: true, periodConfirmed: true, activeTabConfirmed: true };
          }
          if (fnStr.includes('descargar detalles') || fnStr.includes('downloadBtn')) {
            // Botón de descarga no puede ser activado
            return false;
          }
        }
        if (arg === 'Compras' || arg === 'Ventas') {
          return true;
        }
        return false;
      }),
      locator: vi.fn().mockReturnValue(fakeLocator),
    };

    const fakeSession = {
      page: fakePage,
      downloadsPath: tempDir,
      tempRoot: tempDir,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserSession;

    const startSpy = vi.spyOn(BrowserSession, 'start').mockResolvedValue(fakeSession);
    const provider = new StagehandRcvProvider(config, guard);
    const controller = new AbortController();

    const result = await provider.fetch(
      { rut: '11111111-1', password: 'pass', authMode: 'tributaria' },
      controller.signal
    );

    expect(result.compras.status).toBe('error');
    if (result.compras.status === 'error') {
      expect(result.compras.error.code).toBe('DOWNLOAD_TRIGGER_FAILED');
      expect(result.compras.error.stage).toBe('download_trigger');
    }

    await provider.close();
    startSpy.mockRestore();
  }, 15000);
});
