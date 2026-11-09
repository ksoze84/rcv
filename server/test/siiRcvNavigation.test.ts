import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  verifyActiveContributorIdentity,
  selectRcvPeriod,
  ensureRcvResultsLoaded,
  isRcvResultsLoaded,
  verifyPeriodSelected,
  checkRcvResultsStatus,
  selectAndInspectRcvTab,
  triggerRcvDownload,
  inspectActiveContributorDom,
  queryContributorDom,
  queryRcvResultsStatus,
  evaluateSelectPeriodMetadata,
  evaluateSyncAngularPeriod,
  evaluateHasConsultarButton,
  evaluateClickConsultarFallback,
  evaluateClickConsultar,
  evaluateSwitchRcvTab,
  evaluateSwitchComprasRegistroSubtab,
  evaluateInspectRcvActiveTab,
  evaluateClickDownloadCsv,
  evaluateHandleDownloadModal,
  evaluateCollectDataUriAnchors,
  evaluateExtractNewDataUri,
  collectExistingDataUris,
  extractNewDataUri,
  isExactRcvPortalUrl,
  extractUniqueRuts,
  handleNavigationError,
} from '../src/infrastructure/sii/rcvNavigation.js';
import { captureDownload } from '../src/infrastructure/sii/captureDownload.js';
import { AppError } from '../src/domain/errors.js';
import { SiiPageLike } from '../src/infrastructure/sii/siiPage.js';

describe('verifyActiveContributorIdentity', () => {
  it('returns verified: true when expected RUT is in header elements', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockResolvedValue({
        headerText: 'Bienvenido JUAN PEREZ | RUT: 12.345.678-5 | Contribuyente Activo',
      }),
      locator: vi.fn(),
    };

    const res = await verifyActiveContributorIdentity(fakePage, '12345678-5');
    expect(res.verified).toBe(true);
    expect(res.contributorRut).toBe('12345678-5');
  });

  it('returns verified: false when header does not contain expected RUT', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockResolvedValue({
        headerText: 'Bienvenido PEDRO GOMEZ | RUT: 99.888.777-6',
      }),
      locator: vi.fn(),
    };

    const res = await verifyActiveContributorIdentity(fakePage, '12345678-5');
    expect(res.verified).toBe(false);
  });

  it('verifies expected RUT even when header includes dates, phones or secondary numbers', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockResolvedValue({
        hasRcvControls: true,
        headerText: 'JUAN PEREZ | RUT: 12.345.678-5 | Mesa: 223951115 | Fecha: 20260228',
      }),
      locator: vi.fn(),
    };

    const res = await verifyActiveContributorIdentity(fakePage, '12345678-5');
    expect(res.verified).toBe(true);
    expect(res.contributorRut).toBe('12345678-5');
  });

  it('polls until SPA hydration renders expected RUT within timeout', async () => {
    let callCount = 0;
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // SPA aún sin controles ni cabecera inicializada
          return { hasRcvControls: false, headerText: '' };
        }
        return {
          hasRcvControls: true,
          headerText: 'Bienvenido JUAN PEREZ | RUT: 12.345.678-5',
        };
      }),
      locator: vi.fn(),
    };

    const res = await verifyActiveContributorIdentity(fakePage, '12345678-5', undefined, 2000, 50);
    expect(res.verified).toBe(true);
    expect(res.contributorRut).toBe('12345678-5');
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('returns verified: false if timeout expires before SPA hydrates expected RUT', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockResolvedValue({
        hasRcvControls: false,
        headerText: '',
      }),
      locator: vi.fn(),
    };

    const res = await verifyActiveContributorIdentity(fakePage, '12345678-5', undefined, 100, 20);
    expect(res.verified).toBe(false);
  });

  it('returns verified: false when header contains multiple valid RUTs simultaneously', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockResolvedValue({
        hasRcvControls: true,
        headerText: 'Representante: 12.345.678-5 | Empresa: 76.123.456-0',
      }),
      locator: vi.fn(),
    };

    const res = await verifyActiveContributorIdentity(fakePage, '12345678-5');
    expect(res.verified).toBe(false);
  });

  it('returns verified: false when selector has options but no selection is made, without fallback to header', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockResolvedValue({
        hasRcvControls: true,
        selectHasOptions: true,
        selectOptionRuts: ['-- Seleccione una empresa --'],
        headerText: 'Bienvenido JUAN PEREZ | RUT: 12.345.678-5',
      }),
      locator: vi.fn(),
    };

    const res = await verifyActiveContributorIdentity(fakePage, '12345678-5');
    expect(res.verified).toBe(false);
  });

  it('polls until selector with options hydrates the expected RUT within timeout', async () => {
    let callCount = 0;
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            hasRcvControls: true,
            selectHasOptions: true,
            selectOptionRuts: ['-- Seleccione una empresa --'],
            headerText: 'Bienvenido JUAN PEREZ',
          };
        }
        return {
          hasRcvControls: true,
          selectHasOptions: true,
          selectOptionRuts: ['12.345.678-5'],
          headerText: 'Bienvenido JUAN PEREZ',
        };
      }),
      locator: vi.fn(),
    };

    const res = await verifyActiveContributorIdentity(fakePage, '12345678-5', undefined, 2000, 50);
    expect(res.verified).toBe(true);
    expect(res.contributorRut).toBe('12345678-5');
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

describe('inspectActiveContributorDom', () => {
  it('accepts single matching RUT in selector (selectedMatches.length === 1)', () => {
    const evalResult = {
      hasRcvControls: true,
      selectHasOptions: true,
      selectOptionRuts: ['12.345.678-5'],
    };
    expect(inspectActiveContributorDom(evalResult, '12345678-5')).toBe(true);
  });

  it('rejects single non-matching RUT in selector (selectedMatches.length === 1)', () => {
    const evalResult = {
      hasRcvControls: true,
      selectHasOptions: true,
      selectOptionRuts: ['76.123.456-0'],
    };
    expect(inspectActiveContributorDom(evalResult, '12345678-5')).toBe(false);
  });

  it('rejects multiple simultaneous RUTs in selector without accepting includes', () => {
    const evalResult = {
      hasRcvControls: true,
      selectHasOptions: true,
      selectOptionRuts: ['12.345.678-5', '76.123.456-0'],
    };
    // Incluso cuando el RUT esperado está entre las opciones, falla en falso por ambigüedad
    expect(inspectActiveContributorDom(evalResult, '12345678-5')).toBe(false);
  });

  it('fails closed (null) and avoids fallback to header when selector has options but no selection', () => {
    const evalResult = {
      hasRcvControls: true,
      selectHasOptions: true,
      selectOptionRuts: ['-- Seleccionar contribuyente --', ''],
      headerText: 'Bienvenido JUAN PEREZ | RUT: 12.345.678-5',
    };
    // Debe retornar null (fail closed) y NO caer a la cabecera (evita verificar el RUT personal)
    expect(inspectActiveContributorDom(evalResult, '12345678-5')).toBeNull();
  });

  it('accepts single matching RUT in header when selector has no options', () => {
    const evalResult = {
      hasRcvControls: true,
      selectHasOptions: false,
      headerText: 'Bienvenido JUAN PEREZ | RUT: 12.345.678-5',
    };
    expect(inspectActiveContributorDom(evalResult, '12345678-5')).toBe(true);
  });

  it('rejects single non-matching RUT in header when selector has no options', () => {
    const evalResult = {
      hasRcvControls: true,
      selectHasOptions: false,
      headerText: 'Bienvenido PEDRO GOMEZ | RUT: 76.123.456-0',
    };
    expect(inspectActiveContributorDom(evalResult, '12345678-5')).toBe(false);
  });

  it('rejects multiple simultaneous RUTs in header without accepting includes', () => {
    const evalResult = {
      hasRcvControls: true,
      selectHasOptions: false,
      headerText: 'Usuario: 12.345.678-5 | Empresa activa: 76.123.456-0',
    };
    // No acepta includes cuando hay múltiples RUTs simultáneos en cabecera
    expect(inspectActiveContributorDom(evalResult, '12345678-5')).toBe(false);
  });

  it('returns false immediately on public or login page', () => {
    const evalResult = {
      isPublicOrLoginPage: true,
      headerText: '12.345.678-5',
    };
    expect(inspectActiveContributorDom(evalResult, '12345678-5')).toBe(false);
  });

  it('returns null when RCV controls are not present', () => {
    const evalResult = {
      hasRcvControls: false,
      headerText: '',
    };
    expect(inspectActiveContributorDom(evalResult, '12345678-5')).toBeNull();
  });
});

describe('extractUniqueRuts - modulo 11 validation', () => {
  it('filters out non-modulo-11 numbers while preserving valid Chilean RUTs', () => {
    const mixedText = 'Mesa: 223951115 Fecha: 20260228 RUT: 12.345.678-5 Inválido: 12345678-9';
    const ruts = extractUniqueRuts(mixedText);
    expect(ruts).toEqual(['12345678-5']);
  });

  it('normalizes and deduplicates repeated instances of the same RUT', () => {
    const text = 'RUT: 12.345.678-5 y 123456785 y 12345678-5';
    const ruts = extractUniqueRuts(text);
    expect(ruts).toEqual(['12345678-5']);
  });
});

describe('isExactRcvPortalUrl', () => {
  it('accepts exact HTTPS origin https://www4.sii.cl and /consdcvinternetui route', () => {
    expect(isExactRcvPortalUrl('https://www4.sii.cl/consdcvinternetui/#/index')).toBe(true);
    expect(isExactRcvPortalUrl('https://www4.sii.cl/consdcvinternetui/main')).toBe(true);
    expect(isExactRcvPortalUrl('https://www4.sii.cl/consdcvinternetui')).toBe(true);
  });

  it('rejects foreign origins, HTTP protocols, embedded credentials, and foreign paths', () => {
    expect(isExactRcvPortalUrl('https://zeusr.sii.cl/consdcvinternetui/#/index')).toBe(false);
    expect(isExactRcvPortalUrl('https://accounts.claveunica.gob.cl/login')).toBe(false);
    expect(isExactRcvPortalUrl('http://www4.sii.cl/consdcvinternetui/#/index')).toBe(false);
    expect(isExactRcvPortalUrl('https://admin:secret@www4.sii.cl/consdcvinternetui/#/index')).toBe(false);
    expect(isExactRcvPortalUrl('https://www4.sii.cl/otra_aplicacion/#/index')).toBe(false);
  });
});

describe('selectRcvPeriod', () => {
  it('identifies and selects year and month dropdowns via SDK locator', async () => {
    const fakeYearLocator = {
      selectOption: vi.fn().mockResolvedValue(undefined),
    };
    const fakeMonthLocator = {
      selectOption: vi.fn().mockResolvedValue(undefined),
    };

    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn) => {
        if (typeof fn === 'function' && fn.toString().includes('selectCount')) {
          return {
            selectCount: 2,
            yearSelectIndex: 0,
            monthSelectIndex: 1,
            yearValue: '2026',
            monthValue: '02',
          };
        }
        return false; // hasConsultarButton
      }),
      locator: vi.fn().mockImplementation((_sel: string) => {
        return {
          nth: vi.fn().mockImplementation((idx: number) => {
            if (idx === 0) return fakeYearLocator;
            return fakeMonthLocator;
          }),
        };
      }),
    };

    await selectRcvPeriod(fakePage, { year: 2026, month: 2 });
    expect(fakeYearLocator.selectOption).toHaveBeenCalled();
    expect(fakeMonthLocator.selectOption).toHaveBeenCalled();
  });

  it('fails closed with PERIOD_SELECT_FAILED if controls cannot be identified', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockResolvedValue({
        selectCount: 0,
        yearSelectIndex: -1,
        monthSelectIndex: -1,
      }),
      locator: vi.fn(),
    };

    let caughtErr: unknown;
    try {
      await selectRcvPeriod(fakePage, { year: 2026, month: 2 });
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(AppError);
    expect((caughtErr as AppError).code).toBe('PERIOD_SELECT_FAILED');
    expect((caughtErr as AppError).stage).toBe('period_selection');
  });

  it('lanza ANGULAR_NOT_AVAILABLE cuando requireAngular está activo y AngularJS no está disponible', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn) => {
        if (typeof fn === 'function' && fn.toString().includes('selectCount')) {
          return {
            selectCount: 2,
            yearSelectIndex: 0,
            monthSelectIndex: 1,
            yearValue: '2026',
            monthValue: '02',
          };
        }
        // Simular respuesta de sincronización sin angular disponible
        return { angularAvailable: false, angularError: false };
      }),
      locator: vi.fn().mockReturnValue({
        nth: vi.fn().mockReturnValue({ selectOption: vi.fn().mockResolvedValue(undefined) }),
      }),
    };

    let caughtErr: unknown;
    try {
      await selectRcvPeriod(fakePage, { year: 2026, month: 2 }, undefined, { requireAngular: true });
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(AppError);
    expect((caughtErr as AppError).code).toBe('ANGULAR_NOT_AVAILABLE');
    expect((caughtErr as AppError).stage).toBe('period_selection');
  });

  it('lanza QUERY_BUTTON_MISSING cuando clickConsultar está activo y el botón no existe', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn) => {
        if (typeof fn === 'function' && fn.toString().includes('selectCount')) {
          return {
            selectCount: 2,
            yearSelectIndex: 0,
            monthSelectIndex: 1,
            yearValue: '2026',
            monthValue: '02',
          };
        }
        if (typeof fn === 'function' && fn.toString().includes('triggerAngularSelect')) {
          return { angularAvailable: true, angularError: false };
        }
        // Botón no existe
        return false;
      }),
      locator: vi.fn().mockReturnValue({
        nth: vi.fn().mockReturnValue({ selectOption: vi.fn().mockResolvedValue(undefined) }),
      }),
    };

    let caughtErr: unknown;
    try {
      await selectRcvPeriod(fakePage, { year: 2026, month: 2 }, undefined, { clickConsultar: true });
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(AppError);
    expect((caughtErr as AppError).code).toBe('QUERY_BUTTON_MISSING');
    expect((caughtErr as AppError).stage).toBe('query_button');
  });
});

describe('selectAndInspectRcvTab', () => {
  it('inspects Compras tab with movements and download button available', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn, arg) => {
        if (arg === 'Compras') return true;
        return {
          hasNoMovements: false,
          hasDownloadButton: true,
        };
      }),
      locator: vi.fn(),
    };

    const res = await selectAndInspectRcvTab(fakePage, 'Compras');
    expect(res.hasNoMovements).toBe(false);
    expect(res.canDownload).toBe(true);
  });

  it('detects explicit no movements text pattern', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn, arg) => {
        if (arg === 'Ventas') return true;
        return {
          hasNoMovements: true,
          hasDownloadButton: false,
        };
      }),
      locator: vi.fn(),
    };

    const res = await selectAndInspectRcvTab(fakePage, 'Ventas');
    expect(res.hasNoMovements).toBe(true);
    expect(res.canDownload).toBe(false);
  });

  it('circunscribes empty detection to active Compras tab and does not confuse with inactive Ventas empty message', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <nav>
            <a id="tab-compras" href="#compras">Compras</a>
            <a id="tab-ventas" href="#ventas">Ventas</a>
          </nav>
          <select id="sel-year"><option value="2026" selected>2026</option></select>
          <select id="sel-month"><option value="02" selected>Febrero</option></select>
          <div class="tab-content">
            <div id="compras" class="tab-pane active">
              <h2>Registro de Compras</h2>
              <button id="dl-compras">Descargar detalles</button>
            </div>
            <div id="ventas" class="tab-pane">
              <h2>Registro de Ventas</h2>
              <p>No se encontraron registros para el periodo</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const dom = new JSDOM(html);
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn(),
    };

    const res = await selectAndInspectRcvTab(fakePage, 'Compras', undefined, { year: 2026, month: 2 });
    expect(res.hasNoMovements).toBe(false);
    expect(res.canDownload).toBe(true);
    expect(res.periodConfirmed).toBe(true);
  });

  it('detects confirmed empty state when active Ventas pane contains no movements text', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <nav>
            <a id="tab-compras" href="#compras">Compras</a>
            <a id="tab-ventas" href="#ventas">Ventas</a>
          </nav>
          <select id="sel-year"><option value="2026" selected>2026</option></select>
          <select id="sel-month"><option value="02" selected>Febrero</option></select>
          <div class="tab-content">
            <div id="compras" class="tab-pane">
              <button>Descargar detalles</button>
            </div>
            <div id="ventas" class="tab-pane active">
              <p>Sin movimientos para el periodo</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const dom = new JSDOM(html);
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn(),
    };

    const res = await selectAndInspectRcvTab(fakePage, 'Ventas', undefined, { year: 2026, month: 2 });
    expect(res.hasNoMovements).toBe(true);
    expect(res.canDownload).toBe(false);
    expect(res.periodConfirmed).toBe(true);
  });

  it('fails empty detection if period controls do not match expected period (periodo no confirmado)', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <nav>
            <a id="tab-ventas" href="#ventas">Ventas</a>
          </nav>
          <!-- Período seleccionado es 2025-01 en lugar de 2026-02 -->
          <select id="sel-year"><option value="2025" selected>2025</option></select>
          <select id="sel-month"><option value="01" selected>Enero</option></select>
          <div class="tab-content">
            <div id="ventas" class="tab-pane active">
              <p>Sin movimientos</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const dom = new JSDOM(html);
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn(),
    };

    const res = await selectAndInspectRcvTab(fakePage, 'Ventas', undefined, { year: 2026, month: 2 });
    expect(res.periodConfirmed).toBe(false);
    expect(res.hasNoMovements).toBe(false);
  });

  it('does not assume empty when download button is missing without explicit confirmation pattern (fail-closed)', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <nav><a id="tab-ventas" href="#ventas">Ventas</a></nav>
          <select id="sel-year"><option value="2026" selected>2026</option></select>
          <select id="sel-month"><option value="02" selected>Febrero</option></select>
          <div class="tab-content">
            <div id="ventas" class="tab-pane active">
              <!-- No hay botón de descarga ni mensaje explícito de sin movimientos -->
              <p>Cargando información del contribuyente...</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const dom = new JSDOM(html);
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn(),
    };

    const res = await selectAndInspectRcvTab(fakePage, 'Ventas', undefined, { year: 2026, month: 2 });
    expect(res.hasNoMovements).toBe(false);
    expect(res.canDownload).toBe(false);
  });

  it('localiza pestaña singular COMPRA con href #compra/ e id tabCompra ignorando hermanas y subtabs', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <select id="periodoMes" ng-model="periodoMes"><option value="02" selected>Febrero</option></select>
          <select ng-model="periodoAnho"><option value="2026" selected>2026</option></select>
          <ul class="nav nav-tabs">
            <li id="liCompra"><a id="tabCompra" href="#compra/">COMPRA</a></li>
            <li id="liVenta" class="active"><a href="#venta/">VENTA</a></li>
            <li id="liObs"><a href="#observados/">Documentos Observados</a></li>
            <li id="liDif"><a href="#diferidas/">Descargas Diferidas</a></li>
          </ul>
          <!-- Subtabs en COMPRA -->
          <div id="subtabsCompra">
            <ul class="nav nav-pills">
              <li class="active"><a href="#registro/">Registro</a></li>
              <li><a href="#pendientes/">Pendientes</a></li>
              <li><a href="#no-incluir/">No Incluir</a></li>
              <li><a href="#reclamados/">Reclamados</a></li>
            </ul>
          </div>
          <!-- Contenido: tabla resumen de 1 fila y botones -->
          <table class="table"><tr><td>Factura</td><td>1</td></tr></table>
          <button class="btn btn-primary btn-block pull-right ng-scope" ng-click="descargaResumen()">Descargar Resumenes</button>
          <button id="btnDetalle" ng-click="limiteDoc < totDocRes ? confirmar({totDoc:totDocRes, tipoDoc: '0', sec:'1'}) : descargaDetalle()">Descargar Detalles</button>
          <button>Descargar Boletas Electronicas</button>
        </body>
      </html>
    `;

    const dom = new JSDOM(html);
    const liCompra = dom.window.document.getElementById('liCompra')!;
    const liVenta = dom.window.document.getElementById('liVenta')!;
    const tabCompra = dom.window.document.getElementById('tabCompra')!;

    tabCompra.addEventListener('click', (e) => {
      e.preventDefault();
      liVenta.classList.remove('active');
      liCompra.classList.add('active');
    });

    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn(),
    };

    const res = await selectAndInspectRcvTab(fakePage, 'Compras', undefined, { year: 2026, month: 2 });
    expect(res.canDownload).toBe(true);
    expect(res.hasNoMovements).toBe(false);
    expect(res.periodConfirmed).toBe(true);
    expect(res.activeTabConfirmed).toBe(true);
    expect(liCompra.classList.contains('active')).toBe(true);
  });

  it('localiza pestaña singular VENTA con href #venta/ y confirma via LI.active', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <select id="periodoMes" ng-model="periodoMes"><option value="02" selected>Febrero</option></select>
          <select ng-model="periodoAnho"><option value="2026" selected>2026</option></select>
          <ul class="nav nav-tabs">
            <li id="liCompra"><a id="tabCompra" href="#compra/">COMPRA</a></li>
            <li id="liVenta" class="active"><a href="#venta/">VENTA</a></li>
            <li id="liObs"><a href="#observados/">Documentos Observados</a></li>
            <li id="liDif"><a href="#diferidas/">Descargas Diferidas</a></li>
          </ul>
          <table class="table"><tr><td>Factura</td><td>1</td></tr></table>
          <button class="btn btn-primary btn-block pull-right ng-scope" ng-click="descargaResumen()">Descargar Resumenes</button>
          <button ng-click="limiteDoc < totDocRes ? confirmar({totDoc:totDocRes, tipoDoc: '0', sec:'1'}) : descargaDetalle()">Descargar Detalles</button>
          <button>Descargar Boletas Electronicas</button>
        </body>
      </html>
    `;

    const dom = new JSDOM(html);
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn(),
    };

    const res = await selectAndInspectRcvTab(fakePage, 'Ventas', undefined, { year: 2026, month: 2 });
    expect(res.canDownload).toBe(true);
    expect(res.hasNoMovements).toBe(false);
    expect(res.periodConfirmed).toBe(true);
    expect(res.activeTabConfirmed).toBe(true);
  });

  it('falla cerrado si no hay boton Descargar Detalles y solo estan Resumenes y Boletas', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <select id="periodoMes" ng-model="periodoMes"><option value="02" selected>Febrero</option></select>
          <select ng-model="periodoAnho"><option value="2026" selected>2026</option></select>
          <ul class="nav nav-tabs">
            <li class="active"><a href="#venta/">VENTA</a></li>
          </ul>
          <table class="table"><tr><td>Factura</td><td>1</td></tr></table>
          <!-- Solo resumenes y boletas, no detalles -->
          <button class="btn btn-primary btn-block pull-right ng-scope" ng-click="descargaResumen()">Descargar Resumenes</button>
          <button>Descargar Boletas Electronicas</button>
        </body>
      </html>
    `;

    const dom = new JSDOM(html);
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn(),
    };

    const res = await selectAndInspectRcvTab(fakePage, 'Ventas', undefined, { year: 2026, month: 2 });
    expect(res.canDownload).toBe(false);
    expect(res.hasNoMovements).toBe(false);
  });

  it('detecta y pulsa boton Descargar Detalles renderizado FUERA del contenedor de pestaña activa (.tab-pane.active)', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <select id="periodoMes" ng-model="periodoMes"><option value="02" selected>Febrero</option></select>
          <select ng-model="periodoAnho"><option value="2026" selected>2026</option></select>
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
            <li id="liVenta"><a href="#venta/">VENTA</a></li>
          </ul>
          <!-- Contenedor tab-pane activo estándar (sin el botón de descarga) -->
          <div class="tab-content">
            <div id="compras" class="tab-pane active">
              <p>Pestaña compras activa</p>
            </div>
            <div id="ventas" class="tab-pane">
              <p>Pestaña ventas inactiva</p>
            </div>
          </div>
          <!-- Evidencia real autenticada: botón fuera de tab-pane.active renderizado por ruta Angular -->
          <div class="col-md-12 ng-scope">
            <div class="ng-scope">
              <div class="row">
                <div class="col-md-6 col-xs-12">
                  <div class="col-md-6 col-xs-12">
                    <button id="btnDetallesReal" class="btn btn-primary btn-block pull-right ng-scope">Descargar Detalles</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </body>
      </html>
    `;

    const dom = new JSDOM(html);
    let clicked = false;
    const btnDetalle = dom.window.document.getElementById('btnDetallesReal')!;
    btnDetalle.addEventListener('click', () => {
      clicked = true;
    });

    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn(),
    };

    // 1. Debe detectarse en evaluateInspectRcvActiveTab / selectAndInspectRcvTab
    const res = await selectAndInspectRcvTab(fakePage, 'Compras', undefined, { year: 2026, month: 2 });
    expect(res.canDownload).toBe(true);
    expect(res.activeTabConfirmed).toBe(true);
    expect(res.periodConfirmed).toBe(true);
    expect(res.hasNoMovements).toBe(false);

    // 2. Debe pulsarse en evaluateClickDownloadCsv / triggerRcvDownload
    await expect(triggerRcvDownload(fakePage)).resolves.not.toThrow();
    expect(clicked).toBe(true);
  });

  it('detecta y pulsa boton visible cuyo ancestro es .tab-pane SIN clase active pero con display visible', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <select id="periodoMes" ng-model="periodoMes"><option value="02" selected>Febrero</option></select>
          <select ng-model="periodoAnho"><option value="2026" selected>2026</option></select>
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
            <li id="liVenta"><a id="tabVenta" href="#venta/">VENTA</a></li>
          </ul>
          <div class="tab-content">
            <!-- Ancestro es .tab-pane SIN clase active pero con display visible (Angular enruta sin clase active de Bootstrap) -->
            <div id="compraContainer" class="tab-pane" style="display: block;">
              <table class="table"><tr><td>Movimiento Compra</td></tr></table>
              <button id="btnDetalleTabPaneVisible">Descargar Detalles</button>
            </div>
          </div>
        </body>
      </html>
    `;
    const dom = new JSDOM(html);
    let clicked = false;
    const btn = dom.window.document.getElementById('btnDetalleTabPaneVisible')!;
    btn.addEventListener('click', () => {
      clicked = true;
    });

    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#compra/',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn(),
    };

    const res = await selectAndInspectRcvTab(fakePage, 'Compras', undefined, { year: 2026, month: 2 });
    expect(res.canDownload).toBe(true);
    expect(res.activeTabConfirmed).toBe(true);
    expect(res.periodConfirmed).toBe(true);

    await expect(triggerRcvDownload(fakePage)).resolves.not.toThrow();
    expect(clicked).toBe(true);
  });

  it('NO elige boton dentro de ancestro con display:none', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <select id="periodoMes" ng-model="periodoMes"><option value="02" selected>Febrero</option></select>
          <select ng-model="periodoAnho"><option value="2026" selected>2026</option></select>
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
          </ul>
          <div class="tab-content">
            <div style="display: none;">
              <button id="btnDisplayNone">Descargar Detalles</button>
            </div>
          </div>
        </body>
      </html>
    `;
    const dom = new JSDOM(html);
    let clicked = false;
    const btn = dom.window.document.getElementById('btnDisplayNone')!;
    btn.addEventListener('click', () => {
      clicked = true;
    });

    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#compra/',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn(),
    };

    const res = await selectAndInspectRcvTab(fakePage, 'Compras', undefined, { year: 2026, month: 2 });
    expect(res.canDownload).toBe(false);

    await expect(triggerRcvDownload(fakePage)).rejects.toThrow(AppError);
    expect(clicked).toBe(false);
  });

  it('NO elige boton oculto de la pestaña opuesta (panel inactivo .tab-pane:not(.active) o display:none)', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <select id="periodoMes" ng-model="periodoMes"><option value="02" selected>Febrero</option></select>
          <select ng-model="periodoAnho"><option value="2026" selected>2026</option></select>
          <ul class="nav nav-tabs">
            <li id="liCompra"><a id="tabCompra" href="#compra/">COMPRA</a></li>
            <li id="liVenta" class="active"><a id="tabVenta" href="#venta/">VENTA</a></li>
          </ul>
          <!-- Ventas activa no tiene botón -->
          <div class="tab-content">
            <div id="ventas" class="tab-pane active">
              <table class="table"><tr><td>Movimiento Venta</td></tr></table>
            </div>
            <!-- Compras inactiva tiene botón dentro de tab-pane no activo -->
            <div id="compras" class="tab-pane">
              <button id="btnComprasOculto">Descargar Detalles</button>
            </div>
          </div>
          <!-- Otro panel oculto con style display:none -->
          <div id="panel-compras-oculto" style="display: none;">
            <button id="btnComprasDisplayNone">Descargar Detalles</button>
          </div>
        </body>
      </html>
    `;

    const dom = new JSDOM(html);
    const btnComprasOculto = dom.window.document.getElementById('btnComprasOculto')!;
    const btnComprasDisplayNone = dom.window.document.getElementById('btnComprasDisplayNone')!;
    let ocultoClicked = false;
    let displayNoneClicked = false;
    btnComprasOculto.addEventListener('click', () => {
      ocultoClicked = true;
    });
    btnComprasDisplayNone.addEventListener('click', () => {
      displayNoneClicked = true;
    });

    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn(),
    };

    // Inspección en Ventas no debe ver los botones de Compras ocultos
    const res = await selectAndInspectRcvTab(fakePage, 'Ventas', undefined, { year: 2026, month: 2 });
    expect(res.canDownload).toBe(false);
    expect(res.hasNoMovements).toBe(false);

    // triggerRcvDownload debe fallar cerrado y jamás pulsar los botones ocultos de la pestaña opuesta
    await expect(triggerRcvDownload(fakePage)).rejects.toThrow(AppError);
    expect(ocultoClicked).toBe(false);
    expect(displayNoneClicked).toBe(false);
  });

  it('rechaza estrictamente Resumenes y Boletas y preserva fail-closed si no hay Descargar Detalles', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <select id="periodoMes" ng-model="periodoMes"><option value="02" selected>Febrero</option></select>
          <select ng-model="periodoAnho"><option value="2026" selected>2026</option></select>
          <ul class="nav nav-tabs">
            <li class="active"><a href="#compra/">COMPRA</a></li>
          </ul>
          <table class="table"><tr><td>Factura recibida</td></tr></table>
          <button id="btnResumen">Descargar Resumenes</button>
          <button id="btnResumenSingular">Descargar Resumen</button>
          <button id="btnBoleta">Descargar Boletas Electronicas</button>
          <button id="btnBoletaSingular">Descargar Boleta</button>
        </body>
      </html>
    `;

    const dom = new JSDOM(html);
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn(),
    };

    const res = await selectAndInspectRcvTab(fakePage, 'Compras', undefined, { year: 2026, month: 2 });
    // Fail-closed estricto: sin botón y sin texto explícito de sin movimientos -> canDownload=false, hasNoMovements=false
    expect(res.canDownload).toBe(false);
    expect(res.hasNoMovements).toBe(false);

    // triggerRcvDownload no debe tocar resumenes ni boletas
    await expect(triggerRcvDownload(fakePage)).rejects.toThrow(AppError);
  });

  it('detecta boton visible en COMPRA con subpestaña Registro activa (href #compraRegistro/) y relaja criterios de visibilidad', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <select id="periodoMes" ng-model="periodoMes"><option value="02" selected>Febrero</option></select>
          <select ng-model="periodoAnho"><option value="2026" selected>2026</option></select>
          <ul class="nav nav-tabs">
            <li id="liCompra"><a id="tabCompra" href="#compra/">COMPRA</a></li>
            <li id="liVenta"><a id="tabVenta" href="#venta/">VENTA</a></li>
          </ul>
          <!-- Evidencia real autenticada: subpestaña Registro activa con href #compraRegistro/ -->
          <ul class="nav nav-pills">
            <li id="liRegistro" class="active"><a id="subtabRegistro" href="#compraRegistro/">Registro</a></li>
            <li id="liPendientes"><a href="#compraPendientes/">Pendientes</a></li>
            <li id="liNoIncluir"><a href="#compraNoIncluir/">No Incluir</a></li>
            <li id="liReclamados"><a href="#compraReclamados/">Reclamados</a></li>
          </ul>
          <!-- Contenido renderizado fuera de tab-pane.active por enrutador Angular -->
          <div class="row">
            <div class="col-md-12">
              <table class="table">
                <thead><tr><th>Tipo Doc</th><th>RUT Proveedor</th></tr></thead>
                <tbody><tr><td>Factura</td><td>76.123.456-0</td></tr></tbody>
              </table>
              <div class="actions">
                <button id="btnDetallesReal" class="btn btn-primary">Descargar Detalles</button>
              </div>
            </div>
          </div>
        </body>
      </html>
    `;

    const dom = new JSDOM(html);
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn(),
    };

    const res = await selectAndInspectRcvTab(fakePage, 'Compras', undefined, { year: 2026, month: 2 });
    expect(res.canDownload).toBe(true);
    expect(res.activeTabConfirmed).toBe(true);
    expect(res.periodConfirmed).toBe(true);
    expect(res.hasNoMovements).toBe(false);
  });
});

describe('triggerRcvDownload', () => {
  it('triggers download when button is present', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockResolvedValue(true),
      locator: vi.fn(),
    };

    await expect(triggerRcvDownload(fakePage)).resolves.not.toThrow();
  });

  it('throws DOWNLOAD_TRIGGER_FAILED if button is not present', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockResolvedValue(false),
      locator: vi.fn(),
    };

    let caughtErr: unknown;
    try {
      await triggerRcvDownload(fakePage);
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(AppError);
    expect((caughtErr as AppError).code).toBe('DOWNLOAD_TRIGGER_FAILED');
    expect((caughtErr as AppError).stage).toBe('download_trigger');
  });

  it('clasifica excepciones en evaluate dentro de triggerRcvDownload como EVALUATE_FAILED', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockRejectedValue(new Error('page.evaluate: Target closed')),
      locator: vi.fn(),
    };

    let caughtErr: unknown;
    try {
      await triggerRcvDownload(fakePage);
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(AppError);
    expect((caughtErr as AppError).code).toBe('EVALUATE_FAILED');
    expect((caughtErr as AppError).stage).toBe('download_trigger');
    expect((caughtErr as AppError).message).not.toContain('Target closed');
  });

  it('hace click EXCLUSIVAMENTE en el boton Descargar Detalles (nunca Resumenes ni Boletas)', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <button id="btnResumen" class="btn btn-primary btn-block pull-right ng-scope" ng-click="descargaResumen()">Descargar Resumenes</button>
          <button id="btnDetalle" ng-click="limiteDoc < totDocRes ? confirmar({totDoc:totDocRes, tipoDoc: '0', sec:'1'}) : descargaDetalle()">Descargar Detalles</button>
          <button id="btnBoleta">Descargar Boletas Electronicas</button>
        </body>
      </html>
    `;
    const dom = new JSDOM(html);
    const btnResumen = dom.window.document.getElementById('btnResumen')!;
    const btnDetalle = dom.window.document.getElementById('btnDetalle')!;
    const btnBoleta = dom.window.document.getElementById('btnBoleta')!;

    let resumenClicked = false;
    let detalleClicked = false;
    let boletaClicked = false;

    btnResumen.addEventListener('click', () => { resumenClicked = true; });
    btnDetalle.addEventListener('click', () => { detalleClicked = true; });
    btnBoleta.addEventListener('click', () => { boletaClicked = true; });

    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn(),
    };

    await expect(triggerRcvDownload(fakePage)).resolves.not.toThrow();
    expect(detalleClicked).toBe(true);
    expect(resumenClicked).toBe(false);
    expect(boletaClicked).toBe(false);
  });

  it('detecta y acepta el boton de confirmacion del modal cuando aparece por limiteDoc < totDocRes', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <button id="btnDetalle">Descargar Detalles</button>
          <div id="modalConfirm" class="modal in" style="display: block;">
            <div class="modal-dialog">
              <div class="modal-content">
                <div class="modal-header"><h4>Confirmación de descarga</h4></div>
                <div class="modal-body"><p>El número de registros supera el límite. ¿Desea confirmar la descarga?</p></div>
                <div class="modal-footer">
                  <button id="btnCancelar" class="btn btn-default" data-dismiss="modal">Cancelar</button>
                  <button id="btnConfirmar" class="btn btn-primary" ng-click="confirmar()">Confirmar</button>
                </div>
              </div>
            </div>
          </div>
        </body>
      </html>
    `;
    const dom = new JSDOM(html);
    const btnDetalle = dom.window.document.getElementById('btnDetalle')!;
    const btnConfirmar = dom.window.document.getElementById('btnConfirmar')!;
    const btnCancelar = dom.window.document.getElementById('btnCancelar')!;

    let detalleClicked = false;
    let confirmarClicked = false;
    let cancelarClicked = false;

    btnDetalle.addEventListener('click', () => { detalleClicked = true; });
    btnConfirmar.addEventListener('click', () => { confirmarClicked = true; });
    btnCancelar.addEventListener('click', () => { cancelarClicked = true; });

    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn(),
    };

    await expect(triggerRcvDownload(fakePage)).resolves.not.toThrow();
    expect(detalleClicked).toBe(true);
    expect(confirmarClicked).toBe(true);
    expect(cancelarClicked).toBe(false);
  });

  it('lanza DOWNLOAD_CONFIRM_REQUIRED si el modal de confirmacion no se puede resolver de forma determinista', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <button id="btnDetalle">Descargar Detalles</button>
          <div id="modalConfirm" class="modal in" style="display: block;">
            <div class="modal-dialog">
              <div class="modal-content">
                <div class="modal-body"><p>Límite superado.</p></div>
                <div class="modal-footer">
                  <!-- Sin botón de confirmación, solo cancelar -->
                  <button id="btnCancelar" data-dismiss="modal">Cancelar</button>
                </div>
              </div>
            </div>
          </div>
        </body>
      </html>
    `;
    const dom = new JSDOM(html);
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn(),
    };

    let caughtErr: unknown;
    try {
      await triggerRcvDownload(fakePage);
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(AppError);
    expect((caughtErr as AppError).code).toBe('DOWNLOAD_CONFIRM_REQUIRED');
    expect((caughtErr as AppError).stage).toBe('download_trigger');
  });

  it('continua normalmente sin error cuando no aparece modal de confirmacion', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <button id="btnDetalle">Descargar Detalles</button>
        </body>
      </html>
    `;
    const dom = new JSDOM(html);
    const btnDetalle = dom.window.document.getElementById('btnDetalle')!;
    let detalleClicked = false;
    btnDetalle.addEventListener('click', () => { detalleClicked = true; });

    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn(),
    };

    await expect(triggerRcvDownload(fakePage)).resolves.not.toThrow();
    expect(detalleClicked).toBe(true);
  });

  it('sin modal no se lanza DOWNLOAD_CONFIRM_REQUIRED y se captura el data URI', async () => {
    const csvContent = 'RUT Emisor;Folio;Monto\n76123456-7;101;50000\n';
    const encodedCsv = encodeURIComponent(csvContent);
    const dataUri = `data:text/csv;charset=utf-8,${encodedCsv}`;

    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <button id="btnDetalle">Descargar Detalles</button>
        </body>
      </html>
    `;
    const dom = new JSDOM(html);
    const btnDetalle = dom.window.document.getElementById('btnDetalle')!;
    let btnClicked = false;
    btnDetalle.addEventListener('click', () => {
      btnClicked = true;
      const a = dom.window.document.createElement('a');
      a.href = dataUri;
      a.setAttribute('download', 'archivo.csv');
      dom.window.document.body.appendChild(a);
    });

    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#venta/',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn(),
    };

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rcv-test-datauri-'));
    try {
      const bytes = await captureDownload({
        downloadsPath: tempDir,
        page: fakePage,
        action: async () => {
          await triggerRcvDownload(fakePage);
        },
      });

      expect(btnClicked).toBe(true);
      const text = Buffer.from(bytes).toString('utf-8');
      expect(text).toContain('76123456-7');
      expect(text).toContain('50000');
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('collectExistingDataUris y extractNewDataUri invocan evaluate con los parámetros correspondientes', async () => {
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: unknown) => {
        if (fn === evaluateCollectDataUriAnchors) {
          return ['data:text/csv;charset=utf-8,old'];
        }
        if (fn === evaluateExtractNewDataUri) {
          return { found: true, href: 'data:text/csv;charset=utf-8,new' };
        }
        return null;
      }),
      locator: vi.fn(),
    };

    const collected = await collectExistingDataUris(fakePage);
    expect(collected).toEqual(['data:text/csv;charset=utf-8,old']);

    const extracted = await extractNewDataUri(fakePage, collected, 1000);
    expect(extracted.found).toBe(true);
    expect(extracted.href).toBe('data:text/csv;charset=utf-8,new');
  });
});

describe('queryContributorDom with realistic authenticated RCV DOM fixtures', () => {
  const buildRealisticRcvDom = (rutOptionSelected: 'placeholder' | 'company' | 'other_company') => {
    const selectedAttr = (target: string, current: string) => (target === current ? 'selected="selected"' : '');

    return `
      <!DOCTYPE html>
      <html ng-app="sampleMin">
        <head><title>Registro de Compras y Ventas</title></head>
        <body>
          <div id="wrapper">
            <header>
              <div class="user-info">
                <span class="user-name">JUAN PEREZ</span>
              </div>
            </header>
            <main id="consdcv">
              <form name="formConsulta">
                <div class="form-group">
                  <label>RUT Contribuyente:</label>
                  <select name="rut" ng-model="rut">
                    <option value="? undefined:undefined ?" ${selectedAttr('placeholder', rutOptionSelected)}>-- Seleccione Empresa --</option>
                    <option value="number:0" ${selectedAttr('company', rutOptionSelected)}>12.345.678-5 - SOCIEDAD DE PRUEBA SPA</option>
                    ${rutOptionSelected === 'other_company' ? '<option value="number:1" selected="selected">76.123.456-0 - OTRA EMPRESA SPA</option>' : ''}
                  </select>
                </div>
                <div class="form-group">
                  <label>Mes:</label>
                  <select id="periodoMes" name="" ng-model="periodoMes">
                    <option value="?">-- Mes --</option>
                    <option value="string:01">Enero</option>
                    <option value="string:02" selected="selected">Febrero</option>
                    <option value="string:03">Marzo</option>
                    <option value="string:04">Abril</option>
                    <option value="string:05">Mayo</option>
                    <option value="string:06">Junio</option>
                    <option value="string:07">Julio</option>
                    <option value="string:08">Agosto</option>
                    <option value="string:09">Septiembre</option>
                    <option value="string:10">Octubre</option>
                    <option value="string:11">Noviembre</option>
                    <option value="string:12">Diciembre</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>Año:</label>
                  <select id="" name="" ng-model="periodoAnho">
                    <option value="number:2020">2020</option>
                    <option value="number:2021">2021</option>
                    <option value="number:2022">2022</option>
                    <option value="number:2023">2023</option>
                    <option value="number:2024">2024</option>
                    <option value="number:2025">2025</option>
                    <option value="number:2026" selected="selected">2026</option>
                    <option value="number:2027">2027</option>
                    <option value="number:2028">2028</option>
                    <option value="number:2029">2029</option>
                    <option value="number:2030">2030</option>
                  </select>
                </div>
                <button type="button" class="btn btn-primary">Consultar</button>
              </form>
            </main>
          </div>
        </body>
      </html>
    `;
  };

  it('recognizes initial RCV controls, extracts displayed RUT from Angular option text, and verifies identity', () => {
    const dom = new JSDOM(buildRealisticRcvDom('company'));
    const origDoc = globalThis.document;
    const origWin = globalThis.window;
    try {
      (globalThis as unknown as { document: Document }).document = dom.window.document;
      (globalThis as unknown as { window: unknown }).window = dom.window;

      const evalResult = queryContributorDom();
      expect(evalResult.hasRcvControls).toBe(true);
      expect(evalResult.isPublicOrLoginPage).toBe(false);
      expect(evalResult.selectHasOptions).toBe(true);
      expect(evalResult.selectedOptionTexts).toEqual(['12.345.678-5 - SOCIEDAD DE PRUEBA SPA']);
      expect(evalResult.selectedOptionValues).toEqual(['number:0']);

      const match = inspectActiveContributorDom(evalResult, '12345678-5');
      expect(match).toBe(true);

      const mismatch = inspectActiveContributorDom(evalResult, '76123456-0');
      expect(mismatch).toBe(false);
    } finally {
      (globalThis as unknown as { document: Document }).document = origDoc;
      (globalThis as unknown as { window: unknown }).window = origWin;
    }
  });

  it('fails closed (null) when placeholder option is selected (loading / pending hydration), avoiding false empty or permissive identity', () => {
    const dom = new JSDOM(buildRealisticRcvDom('placeholder'));
    const origDoc = globalThis.document;
    const origWin = globalThis.window;
    try {
      (globalThis as unknown as { document: Document }).document = dom.window.document;
      (globalThis as unknown as { window: unknown }).window = dom.window;

      const evalResult = queryContributorDom();
      expect(evalResult.hasRcvControls).toBe(true);
      expect(evalResult.isPublicOrLoginPage).toBe(false);
      expect(evalResult.selectHasOptions).toBe(true);
      expect(evalResult.selectedOptionTexts).toEqual(['-- Seleccione Empresa --']);
      expect(evalResult.selectedOptionValues).toEqual(['? undefined:undefined ?']);

      // No es falso empty (no retorna false inmediatamente que abortaría el sondeo de hidratación)
      // Ni es identidad permisiva (no retorna true bajo placeholder)
      const status = inspectActiveContributorDom(evalResult, '12345678-5');
      expect(status).toBeNull();
    } finally {
      (globalThis as unknown as { document: Document }).document = origDoc;
      (globalThis as unknown as { window: unknown }).window = origWin;
    }
  });

  it('rejects when another contributor option is selected in the Angular select', () => {
    const dom = new JSDOM(buildRealisticRcvDom('other_company'));
    const origDoc = globalThis.document;
    const origWin = globalThis.window;
    try {
      (globalThis as unknown as { document: Document }).document = dom.window.document;
      (globalThis as unknown as { window: unknown }).window = dom.window;

      const evalResult = queryContributorDom();
      expect(evalResult.hasRcvControls).toBe(true);
      expect(evalResult.selectedOptionTexts).toEqual(['76.123.456-0 - OTRA EMPRESA SPA']);

      const match = inspectActiveContributorDom(evalResult, '12345678-5');
      expect(match).toBe(false);
    } finally {
      (globalThis as unknown as { document: Document }).document = origDoc;
      (globalThis as unknown as { window: unknown }).window = origWin;
    }
  });

  it('prioritizes selected option text over Angular internal values that might mimic numbers', () => {
    const evalResult = {
      hasRcvControls: true,
      selectHasOptions: true,
      selectedOptionTexts: ['12.345.678-5 - SOCIEDAD DE PRUEBA SPA'],
      selectedOptionValues: ['number:0'],
      selectOptionRuts: ['12.345.678-5 - SOCIEDAD DE PRUEBA SPA', 'number:0'],
    };

    expect(inspectActiveContributorDom(evalResult, '12345678-5')).toBe(true);
    expect(inspectActiveContributorDom(evalResult, '99999999-9')).toBe(false);
  });

  it('discovers year and month selects matching observed ng-model="periodoAnho" and id="periodoMes"', async () => {
    const dom = new JSDOM(buildRealisticRcvDom('company'));
    const fakeYearLocator = { selectOption: vi.fn().mockResolvedValue(undefined) };
    const fakeMonthLocator = { selectOption: vi.fn().mockResolvedValue(undefined) };
    const fakeConsultarLocator = { click: vi.fn().mockResolvedValue(undefined) };

    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn().mockImplementation((sel: string) => {
        if (sel === 'select') {
          return {
            nth: vi.fn().mockImplementation((idx: number) => {
              if (idx === 2) return fakeYearLocator; // periodoAnho is 3rd select (index 2)
              if (idx === 1) return fakeMonthLocator; // periodoMes is 2nd select (index 1)
              return { selectOption: vi.fn() };
            }),
          };
        }
        return {
          first: vi.fn().mockReturnValue(fakeConsultarLocator),
        };
      }),
    };

    await selectRcvPeriod(fakePage, { year: 2026, month: 2 }, undefined, { clickConsultar: true });
    expect(fakeYearLocator.selectOption).toHaveBeenCalledWith('number:2026');
    expect(fakeMonthLocator.selectOption).toHaveBeenCalledWith('string:02');
    expect(fakeConsultarLocator.click).toHaveBeenCalled();
  });
});

describe('ensureRcvResultsLoaded and realistic consultation DOM fixtures', () => {
  const buildInitialRcvDom = () => {
    return `
      <!DOCTYPE html>
      <html ng-app="sampleMin">
        <head><title>Registro de Compras y Ventas</title></head>
        <body>
          <div id="wrapper">
            <header>
              <div class="user-info">
                <span class="user-name">JUAN PEREZ</span>
              </div>
            </header>
            <main id="consdcv">
              <form name="formConsulta" id="formConsulta">
                <div class="form-group">
                  <label>RUT:</label>
                  <select name="rut" ng-model="rut">
                    <option value="number:0" selected="selected">12.345.678-5 - EMPRESA PRUEBA SPA</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>Mes:</label>
                  <select id="periodoMes" name="" ng-model="periodoMes">
                    <option value="string:01">Enero</option>
                    <option value="string:02" selected="selected">Febrero</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>Año:</label>
                  <select id="" name="" ng-model="periodoAnho">
                    <option value="number:2025">2025</option>
                    <option value="number:2026" selected="selected">2026</option>
                  </select>
                </div>
                <button type="submit" class="btn btn-default btn-xs-block btn-block">Consultar</button>
              </form>
              <div id="results-area"></div>
            </main>
          </div>
        </body>
      </html>
    `;
  };

  const createFakePageFromDom = (dom: JSDOM, onConsultarClick?: () => void): SiiPageLike => {
    const consultarBtn = dom.window.document.querySelector('button[type="submit"]');
    if (consultarBtn && onConsultarClick) {
      consultarBtn.addEventListener('click', (e) => {
        e.preventDefault();
        onConsultarClick();
      });
    }

    return {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn().mockImplementation((_sel: string) => {
        return {
          nth: vi.fn().mockReturnValue({ selectOption: vi.fn().mockResolvedValue(undefined) }),
          first: vi.fn().mockReturnValue({
            click: vi.fn().mockImplementation(async () => {
              if (onConsultarClick) {
                onConsultarClick();
              }
            }),
          }),
        };
      }),
    };
  };

  it('checkRcvResultsStatus y verifyPeriodSelected reflejan estado exacto del DOM', async () => {
    const dom = new JSDOM(buildInitialRcvDom());
    const fakePage = createFakePageFromDom(dom);

    const status = await checkRcvResultsStatus(fakePage, { year: 2026, month: 2 });
    expect(status.hasConsultarButton).toBe(true);
    expect(status.periodConfirmed).toBe(true);
    expect(status.hasTabs).toBe(false);

    const isConfirmed = await verifyPeriodSelected(fakePage, { year: 2026, month: 2 });
    expect(isConfirmed).toBe(true);
  });

  it('click Consultar requerido antes tabs: falla si se intentan buscar pestañas antes de consultar', async () => {
    const dom = new JSDOM(buildInitialRcvDom());
    const fakePage = createFakePageFromDom(dom);

    // En la pantalla inicial autenticada NO existen pestañas ni tablas
    const loaded = await isRcvResultsLoaded(fakePage, { year: 2026, month: 2 });
    expect(loaded).toBe(false);

    // Buscar Compras directamente sin haber consultado lanza TAB_NOT_FOUND con stage tab_selection
    let caughtErr: unknown;
    try {
      await selectAndInspectRcvTab(fakePage, 'Compras', undefined, { year: 2026, month: 2 });
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(AppError);
    expect((caughtErr as AppError).code).toBe('TAB_NOT_FOUND');
    expect((caughtErr as AppError).stage).toBe('tab_selection');
  });

  it('aparicion posterior tabs/tabla: hace click Consultar y espera render resultados', async () => {
    const dom = new JSDOM(buildInitialRcvDom());
    let consultarClickCount = 0;

    const fakePage = createFakePageFromDom(dom, () => {
      consultarClickCount++;
      // Simular render de resultados en la SPA tras hacer click en Consultar
      const resultsArea = dom.window.document.getElementById('results-area')!;
      resultsArea.innerHTML = `
        <div class="tab-content">
          <ul class="nav nav-tabs">
            <li class="active"><a id="tab-compras" role="tab" class="active">Compras</a></li>
            <li><a id="tab-ventas" role="tab">Ventas</a></li>
          </ul>
          <div id="compras" class="tab-pane active">
            <table class="table table-striped">
              <thead><tr><th>Folio</th><th>RUT</th></tr></thead>
              <tbody><tr><td>1001</td><td>76.123.456-0</td></tr></tbody>
            </table>
            <button id="btn-dl-compras">Descargar detalles</button>
          </div>
          <div id="ventas" class="tab-pane">
            <p>No se encontraron registros para el periodo</p>
          </div>
        </div>
      `;
    });

    // Antes de consultar, no hay resultados cargados
    expect(await isRcvResultsLoaded(fakePage, { year: 2026, month: 2 })).toBe(false);

    // ensureRcvResultsLoaded selecciona período, hace click Consultar y espera render
    await ensureRcvResultsLoaded(fakePage, { year: 2026, month: 2 }, undefined, 5000, 50);

    expect(consultarClickCount).toBe(1);
    expect(await isRcvResultsLoaded(fakePage, { year: 2026, month: 2 })).toBe(true);

    // Ahora las pestañas y tablas existen en el DOM
    const inspection = await selectAndInspectRcvTab(fakePage, 'Compras', undefined, { year: 2026, month: 2 });
    expect(inspection.canDownload).toBe(true);
    expect(inspection.hasNoMovements).toBe(false);
    expect(inspection.periodConfirmed).toBe(true);
  });

  it('evita reconsultar innecesario entre compras y ventas si UI ya cargada', async () => {
    const dom = new JSDOM(buildInitialRcvDom());
    let consultarClickCount = 0;

    const fakePage = createFakePageFromDom(dom, () => {
      consultarClickCount++;
      const resultsArea = dom.window.document.getElementById('results-area')!;
      resultsArea.innerHTML = `
        <div class="tab-content">
          <a id="tab-compras" role="tab">Registro de Compras</a>
          <a id="tab-ventas" role="tab">Registro de Ventas</a>
          <div id="compras" class="tab-pane active"><button>Descargar detalles</button></div>
          <div id="ventas" class="tab-pane"><p>Sin movimientos para el periodo</p></div>
        </div>
      `;
    });

    // Primera llamada (para Compras): consulta y renderiza
    await ensureRcvResultsLoaded(fakePage, { year: 2026, month: 2 }, undefined, 5000, 50);
    expect(consultarClickCount).toBe(1);

    // Segunda llamada (para Ventas): detecta que la UI ya está cargada para 2026-02 y NO reconsulta
    await ensureRcvResultsLoaded(fakePage, { year: 2026, month: 2 }, undefined, 5000, 50);
    expect(consultarClickCount).toBe(1); // Se mantiene en 1, sin click innecesario
  });

  it('sin movimientos explicito: retorna hasNoMovements true y canDownload false', async () => {
    const dom = new JSDOM(buildInitialRcvDom());
    const resultsArea = dom.window.document.getElementById('results-area')!;
    resultsArea.innerHTML = `
      <div class="tab-content">
        <a id="tab-ventas" role="tab">Registro de Ventas</a>
        <div id="ventas" class="tab-pane active">
          <p>Sin información para el periodo</p>
        </div>
      </div>
    `;

    const fakePage = createFakePageFromDom(dom);
    const inspection = await selectAndInspectRcvTab(fakePage, 'Ventas', undefined, { year: 2026, month: 2 });
    expect(inspection.hasNoMovements).toBe(true);
    expect(inspection.canDownload).toBe(false);
    expect(inspection.periodConfirmed).toBe(true);
  });

  it('boton descarga ausente: mantiene fail-closed sin declarar empty arbitrariamente', async () => {
    const dom = new JSDOM(buildInitialRcvDom());
    const resultsArea = dom.window.document.getElementById('results-area')!;
    // UI cargada con registros pero sin botón de descarga y sin mensaje de "sin movimientos"
    resultsArea.innerHTML = `
      <div class="tab-content">
        <a id="tab-compras" role="tab">Compras</a>
        <div id="compras" class="tab-pane active">
          <table class="table"><tr><td>Item 1</td></tr></table>
          <!-- Falta botón de descarga -->
        </div>
      </div>
    `;

    const fakePage = createFakePageFromDom(dom);
    const inspection = await selectAndInspectRcvTab(fakePage, 'Compras', undefined, { year: 2026, month: 2 });
    // Fail closed estricto: no declara empty
    expect(inspection.hasNoMovements).toBe(false);
    expect(inspection.canDownload).toBe(false);
  });

  it('subpestaña Registro seleccionada explícitamente tras COMPRA sin tocar Pendientes, No Incluir ni Reclamados', async () => {
    const dom = new JSDOM(buildInitialRcvDom());
    const resultsArea = dom.window.document.getElementById('results-area')!;
    resultsArea.innerHTML = `
      <div class="tab-content">
        <ul class="nav nav-tabs">
          <li class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
          <li><a id="tabVenta" href="#venta/">VENTA</a></li>
        </ul>
        <div id="compra-container">
          <ul class="nav nav-pills subtabs">
            <li><a id="subtab-registro" href="#registro">Registro</a></li>
            <li><a id="subtab-pendientes" href="#pendientes">Pendientes</a></li>
            <li><a id="subtab-noincluir" href="#noincluir">No Incluir</a></li>
            <li><a id="subtab-reclamados" href="#reclamados">Reclamados</a></li>
          </ul>
          <!-- Contenido renderizado fuera de .tab-pane.active según evidencia real -->
          <div id="subtab-content-outside-active">
            <button id="btn-dl-compras">Descargar detalles</button>
          </div>
        </div>
      </div>
    `;

    let registroClicks = 0;
    let pendientesClicks = 0;
    let noIncluirClicks = 0;
    let reclamadosClicks = 0;

    dom.window.document.getElementById('subtab-registro')?.addEventListener('click', () => {
      registroClicks++;
    });
    dom.window.document.getElementById('subtab-pendientes')?.addEventListener('click', () => {
      pendientesClicks++;
    });
    dom.window.document.getElementById('subtab-noincluir')?.addEventListener('click', () => {
      noIncluirClicks++;
    });
    dom.window.document.getElementById('subtab-reclamados')?.addEventListener('click', () => {
      reclamadosClicks++;
    });

    const fakePage = createFakePageFromDom(dom);
    const inspection = await selectAndInspectRcvTab(fakePage, 'Compras', undefined, { year: 2026, month: 2 });

    expect(registroClicks).toBe(1);
    expect(pendientesClicks).toBe(0);
    expect(noIncluirClicks).toBe(0);
    expect(reclamadosClicks).toBe(0);
    expect(inspection.canDownload).toBe(true);
    expect(inspection.hasNoMovements).toBe(false);
    expect(inspection.activeTabConfirmed).toBe(true);
    expect(inspection.periodConfirmed).toBe(true);
  });

  it('espera acotada hasta aparición de botón Descargar Detalles tras re-render dinámico de Angular', async () => {
    const dom = new JSDOM(buildInitialRcvDom());
    const resultsArea = dom.window.document.getElementById('results-area')!;
    resultsArea.innerHTML = `
      <div class="tab-content">
        <ul class="nav nav-tabs">
          <li class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
        </ul>
        <div id="compra-view">
          <table class="table"><tr><td>Cargando datos...</td></tr></table>
          <!-- El botón no existe inicialmente -->
        </div>
      </div>
    `;

    // Simular que Angular re-renderiza y añade el botón tras 60ms
    setTimeout(() => {
      const container = dom.window.document.getElementById('compra-view');
      if (container) {
        const btn = dom.window.document.createElement('button');
        btn.id = 'btn-dl';
        btn.textContent = 'Descargar Detalles';
        container.appendChild(btn);
      }
    }, 60);

    const fakePage = createFakePageFromDom(dom);
    const inspection = await selectAndInspectRcvTab(
      fakePage,
      'Compras',
      undefined,
      { year: 2026, month: 2 },
      { timeoutMs: 500, pollIntervalMs: 25 }
    );

    expect(inspection.canDownload).toBe(true);
    expect(inspection.hasNoMovements).toBe(false);
  });

  it('espera acotada hasta aparición de mensaje explícito de sin movimientos tras re-render dinámico', async () => {
    const dom = new JSDOM(buildInitialRcvDom());
    const resultsArea = dom.window.document.getElementById('results-area')!;
    resultsArea.innerHTML = `
      <div class="tab-content">
        <ul class="nav nav-tabs">
          <li class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
        </ul>
        <div id="compra-view">
          <!-- Mensaje no existe inicialmente -->
        </div>
      </div>
    `;

    // Simular que Angular re-renderiza y añade el mensaje de sin movimientos tras 60ms
    setTimeout(() => {
      const container = dom.window.document.getElementById('compra-view');
      if (container) {
        const msg = dom.window.document.createElement('div');
        msg.className = 'alert alert-info';
        msg.textContent = 'No se encontraron registros para el periodo';
        container.appendChild(msg);
      }
    }, 60);

    const fakePage = createFakePageFromDom(dom);
    const inspection = await selectAndInspectRcvTab(
      fakePage,
      'Compras',
      undefined,
      { year: 2026, month: 2 },
      { timeoutMs: 500, pollIntervalMs: 25 }
    );

    expect(inspection.hasNoMovements).toBe(true);
    expect(inspection.canDownload).toBe(false);
  });

  it('timeout esperando render de resultados lanza RESULTS_NOT_RENDERED', async () => {
    const dom = new JSDOM(buildInitialRcvDom());
    // Click en Consultar no renderiza nada (servidor lento o bloqueado)
    const fakePage = createFakePageFromDom(dom, () => {});

    await expect(
      ensureRcvResultsLoaded(fakePage, { year: 2026, month: 2 }, undefined, 200, 50)
    ).rejects.toThrow(AppError);

    try {
      await ensureRcvResultsLoaded(fakePage, { year: 2026, month: 2 }, undefined, 200, 50);
    } catch (err) {
      expect((err as AppError).code).toBe('RESULTS_NOT_RENDERED');
      expect((err as AppError).stage).toBe('results_render');
    }
  });

  it('queryRcvResultsStatus detecta los mensajes reales "No hay información de Registro." y "No hay información de Ventas."', async () => {
    const domRegistro = new JSDOM(buildInitialRcvDom());
    domRegistro.window.document.getElementById('results-area')!.innerHTML = `
      <div class="alert alert-danger">No hay información de Registro.</div>
    `;
    const pageRegistro = createFakePageFromDom(domRegistro);
    const statusRegistro = await checkRcvResultsStatus(pageRegistro, { year: 2026, month: 2 });
    expect(statusRegistro.hasNoMovementsMessage).toBe(true);
    expect(statusRegistro.noMovementsText).toBe('no hay informacion de registro');
    expect(statusRegistro.hasErrorMessage).toBe(false);

    const domVentas = new JSDOM(buildInitialRcvDom());
    domVentas.window.document.getElementById('results-area')!.innerHTML = `
      <div class="alert alert-danger">No hay información de Ventas.</div>
    `;
    const pageVentas = createFakePageFromDom(domVentas);
    const statusVentas = await checkRcvResultsStatus(pageVentas, { year: 2026, month: 2 });
    expect(statusVentas.hasNoMovementsMessage).toBe(true);
    expect(statusVentas.noMovementsText).toBe('no hay informacion de ventas');
    expect(statusVentas.hasErrorMessage).toBe(false);
  });

  describe('Flujo determinista por pestaña: re-consulta obligatoria al cambiar de pestaña en SPA', () => {
    it('tras cambiar de pestaña el contenido previo desaparece y se requiere nueva consulta', async () => {
      // Escenario real: Ventas previamente consultado y renderizado
      const dom = new JSDOM(buildInitialRcvDom());
      let consultarClickCount = 0;
      let activeTab = 'Venta';

      const resultsArea = dom.window.document.getElementById('results-area')!;
      // Estado inicial: Ventas tiene resultados cargados en el DOM
      resultsArea.innerHTML = `
        <div id="venta-results" class="tab-content">
          <ul class="nav nav-tabs">
            <li id="liVenta" class="active"><a id="tabVenta" href="#venta/">VENTA</a></li>
            <li id="liCompra"><a id="tabCompra" href="#compra/">COMPRA</a></li>
          </ul>
          <div id="ventaContainer" class="tab-pane active">
            <table class="table"><tr><td>Factura Venta</td><td>1</td></tr></table>
            <button id="btn-dl-ventas">Descargar Detalles</button>
          </div>
        </div>
      `;

      // Simular SPA: al hacer click en tabCompra, se descarta el contenido previo y se limpian resultados
      const tabCompra = dom.window.document.getElementById('tabCompra')!;
      tabCompra.addEventListener('click', () => {
        activeTab = 'Compra';
        // Evidencia real: al cambiar de pestaña el contenido previo desaparece y no hay li.active
        const liVenta = dom.window.document.getElementById('liVenta');
        const liCompra = dom.window.document.getElementById('liCompra');
        liVenta?.classList.remove('active');
        liCompra?.classList.remove('active');
        const container = dom.window.document.getElementById('ventaContainer');
        if (container) {
          container.remove();
        }
      });

      const tabVenta = dom.window.document.getElementById('tabVenta')!;
      tabVenta.addEventListener('click', () => {
        activeTab = 'Venta';
      });

      const fakePage = createFakePageFromDom(dom, () => {
        consultarClickCount++;
        // Al pulsar Consultar, la SPA renderiza el contenido de la pestaña elegida (Compras)
        if (activeTab === 'Compra') {
          const liCompra = dom.window.document.getElementById('liCompra');
          liCompra?.classList.add('active');
          resultsArea.innerHTML = `
            <div id="compra-results" class="tab-content">
              <ul class="nav nav-tabs">
                <li id="liVenta"><a id="tabVenta" href="#venta/">VENTA</a></li>
                <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
              </ul>
              <div id="compraContainer" class="tab-pane active">
                <table class="table"><tr><td>Factura Compra</td><td>1</td></tr></table>
                <button id="btn-dl-compras">Descargar Detalles</button>
              </div>
            </div>
          `;
        }
      });

      // Ejecutar flujo determinista para Compras con re-consulta obligatoria
      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: true, requireConsultar: true, timeoutMs: 1000, pollIntervalMs: 30 }
      );

      // Debe haber ejecutado la consulta nuevamente
      expect(consultarClickCount).toBe(1);
      expect(inspection.canDownload).toBe(true);
      expect(inspection.hasNoMovements).toBe(false);
      expect(inspection.periodConfirmed).toBe(true);
      expect(inspection.activeTabConfirmed).toBe(true);
    });

    it('flujo COMPRA con subpestaña Registro y boton', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      let consultarClickCount = 0;
      let registroClicks = 0;
      let pendientesClicks = 0;
      let noIncluirClicks = 0;
      let reclamadosClicks = 0;

      const resultsArea = dom.window.document.getElementById('results-area')!;
      resultsArea.innerHTML = `
        <div class="tab-content">
          <ul class="nav nav-tabs">
            <li id="liCompra"><a id="tabCompra" href="#compra/">COMPRA</a></li>
            <li id="liVenta" class="active"><a id="tabVenta" href="#venta/">VENTA</a></li>
          </ul>
          <div id="compraContainer"></div>
        </div>
      `;

      const fakePage = createFakePageFromDom(dom, () => {
        consultarClickCount++;
        const liCompra = dom.window.document.getElementById('liCompra');
        liCompra?.classList.add('active');
        const container = dom.window.document.getElementById('compraContainer')!;
        container.innerHTML = `
          <!-- Subpestañas reales de compra observadas en SPA -->
          <ul class="nav nav-pills subtabs">
            <li id="subtabRegistroLi"><a id="tabRegistro" href="#compraRegistro/">Registro</a></li>
            <li id="subtabPendientesLi"><a id="tabPendientes" href="#compraPendientes/">Pendientes</a></li>
            <li id="subtabNoIncluirLi"><a id="tabNoIncluir" href="#compraNoIncluir/">No Incluir</a></li>
            <li id="subtabReclamadosLi"><a id="tabReclamados" href="#compraReclamados/">Reclamados</a></li>
          </ul>
          <div id="compraContent">
            <table class="table"><tr><td>Factura Compra 12345</td></tr></table>
            <button id="btn-dl-compras">Descargar Detalles</button>
          </div>
        `;

        dom.window.document.getElementById('tabRegistro')?.addEventListener('click', () => {
          registroClicks++;
          dom.window.document.getElementById('subtabRegistroLi')?.classList.add('active');
        });
        dom.window.document.getElementById('tabPendientes')?.addEventListener('click', () => {
          pendientesClicks++;
        });
        dom.window.document.getElementById('tabNoIncluir')?.addEventListener('click', () => {
          noIncluirClicks++;
        });
        dom.window.document.getElementById('tabReclamados')?.addEventListener('click', () => {
          reclamadosClicks++;
        });
      });

      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: true, requireConsultar: true, timeoutMs: 1000, pollIntervalMs: 30 }
      );

      expect(consultarClickCount).toBe(1);
      expect(registroClicks).toBe(1);
      expect(pendientesClicks).toBe(0);
      expect(noIncluirClicks).toBe(0);
      expect(reclamadosClicks).toBe(0);
      expect(inspection.canDownload).toBe(true);
      expect(inspection.hasNoMovements).toBe(false);
      expect(inspection.activeTabConfirmed).toBe(true);
      expect(inspection.periodConfirmed).toBe(true);
    });

    it('flujo VENTA', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      let consultarClickCount = 0;

      const resultsArea = dom.window.document.getElementById('results-area')!;
      resultsArea.innerHTML = `
        <div class="tab-content">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
            <li id="liVenta"><a id="tabVenta" href="#venta/">VENTA</a></li>
          </ul>
          <div id="ventaContainer"></div>
        </div>
      `;

      const fakePage = createFakePageFromDom(dom, () => {
        consultarClickCount++;
        const liVenta = dom.window.document.getElementById('liVenta');
        liVenta?.classList.add('active');
        const container = dom.window.document.getElementById('ventaContainer')!;
        container.className = 'tab-pane active';
        container.innerHTML = `
          <table class="table"><tr><td>Factura Venta 98765</td></tr></table>
          <button class="btn btn-primary" id="btn-dl-ventas">Descargar Detalles</button>
          <button id="btn-resumen">Descargar Resumenes</button>
          <button id="btn-boletas">Descargar Boletas Electronicas</button>
        `;
      });

      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Ventas',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: true, requireConsultar: true, timeoutMs: 1000, pollIntervalMs: 30 }
      );

      expect(consultarClickCount).toBe(1);
      expect(inspection.canDownload).toBe(true);
      expect(inspection.hasNoMovements).toBe(false);
      expect(inspection.activeTabConfirmed).toBe(true);
      expect(inspection.periodConfirmed).toBe(true);
    });

    it('caso sin movimientos declarado por el portal tras consultar', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      let consultarClickCount = 0;

      const resultsArea = dom.window.document.getElementById('results-area')!;
      resultsArea.innerHTML = `
        <div class="tab-content">
          <ul class="nav nav-tabs">
            <li id="liCompra"><a id="tabCompra" href="#compra/">COMPRA</a></li>
            <li id="liVenta" class="active"><a id="tabVenta" href="#venta/">VENTA</a></li>
          </ul>
          <div id="compraContainer"></div>
        </div>
      `;

      const fakePage = createFakePageFromDom(dom, () => {
        consultarClickCount++;
        const liCompra = dom.window.document.getElementById('liCompra');
        liCompra?.classList.add('active');
        const container = dom.window.document.getElementById('compraContainer')!;
        container.className = 'tab-pane active';
        container.innerHTML = `
          <!-- Mensaje explícito del portal sin registros -->
          <p>No se encontraron registros para el periodo</p>
        `;
      });

      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: true, requireConsultar: true, timeoutMs: 1000, pollIntervalMs: 30 }
      );

      expect(consultarClickCount).toBe(1);
      expect(inspection.hasNoMovements).toBe(true);
      expect(inspection.canDownload).toBe(false);
      expect(inspection.activeTabConfirmed).toBe(true);
      expect(inspection.periodConfirmed).toBe(true);
    });

    it('confirmación de pestaña activa sin li.active pero con contenido objetivo visible', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <body>
            <select id="periodoMes" ng-model="periodoMes"><option value="02" selected>Febrero</option></select>
            <select ng-model="periodoAnho"><option value="2026" selected>2026</option></select>
            <ul class="nav nav-tabs">
              <!-- Evidencia real: tras consultar puede no haber ningún li.active -->
              <li id="liCompra"><a id="tabCompra" href="#compra/">COMPRA</a></li>
              <li id="liVenta"><a id="tabVenta" href="#venta/">VENTA</a></li>
            </ul>
            <div id="ventaContainer" class="tab-pane" style="display: block;">
              <table class="table"><tr><td>Factura Venta</td><td>1</td></tr></table>
              <button id="btn-dl-ventas">Descargar Detalles</button>
            </div>
          </body>
        </html>
      `;
      const dom = new JSDOM(html);
      const fakePage = createFakePageFromDom(dom);

      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Ventas',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 500, pollIntervalMs: 30 }
      );

      expect(inspection.activeTabConfirmed).toBe(true);
      expect(inspection.periodConfirmed).toBe(true);
      expect(inspection.canDownload).toBe(true);
      expect(inspection.hasNoMovements).toBe(false);
    });

    it('no confirma la pestaña cuando la pestaña opuesta está activa', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <body>
            <select id="periodoMes" ng-model="periodoMes"><option value="02" selected>Febrero</option></select>
            <select ng-model="periodoAnho"><option value="2026" selected>2026</option></select>
            <ul class="nav nav-tabs">
              <!-- Pestaña opuesta (COMPRA) está explícitamente activa -->
              <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
              <li id="liVenta"><a id="tabVenta" href="#venta/">VENTA</a></li>
            </ul>
            <div id="compraContainer" class="tab-pane active" style="display: block;">
              <table class="table"><tr><td>Factura Compra</td><td>1</td></tr></table>
              <button id="btn-dl-compras">Descargar Detalles</button>
            </div>
          </body>
        </html>
      `;
      const dom = new JSDOM(html);

      // Evaluación directa de evaluateInspectRcvActiveTab buscando 'Ventas'
      const origDoc = globalThis.document;
      const origWin = globalThis.window;
      let inspection;
      try {
        (globalThis as unknown as { document: Document }).document = dom.window.document;
        (globalThis as unknown as { window: unknown }).window = dom.window;
        inspection = evaluateInspectRcvActiveTab({
          targetTab: 'Ventas',
          expectedPeriod: { year: 2026, month: 2 },
        });
      } finally {
        (globalThis as unknown as { document: Document }).document = origDoc;
        (globalThis as unknown as { window: unknown }).window = origWin;
      }

      // Debe rechazar la confirmación porque la pestaña opuesta es la activa
      expect(inspection.activeTabConfirmed).toBe(false);
      expect(inspection.hasDownloadButton).toBe(false);
    });

    it('no re-consulta el período si el botón Descargar Detalles ya está visible y el período confirmado', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      let consultarClickCount = 0;

      const resultsArea = dom.window.document.getElementById('results-area')!;
      // El contenido de Ventas ya está renderizado y el botón visible antes de llamar a selectAndInspectRcvTab
      resultsArea.innerHTML = `
        <div id="venta-results" class="tab-content">
          <ul class="nav nav-tabs">
            <li id="liCompra"><a id="tabCompra" href="#compra/">COMPRA</a></li>
            <li id="liVenta" class="active"><a id="tabVenta" href="#venta/">VENTA</a></li>
          </ul>
          <div id="ventaContainer" class="tab-pane active">
            <table class="table"><tr><td>Factura Venta</td><td>1</td></tr></table>
            <button id="btn-dl-ventas">Descargar Detalles</button>
          </div>
        </div>
      `;

      const fakePage = createFakePageFromDom(dom, () => {
        consultarClickCount++;
      });

      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Ventas',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: true, requireConsultar: true, timeoutMs: 1000, pollIntervalMs: 30 }
      );

      // NO debe haber pulsado Consultar porque el botón ya estaba visible y el período confirmado
      expect(consultarClickCount).toBe(0);
      expect(inspection.canDownload).toBe(true);
      expect(inspection.activeTabConfirmed).toBe(true);
      expect(inspection.periodConfirmed).toBe(true);
    });

    it('re-consulta el período si no hay contenido renderizado para la pestaña', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      let consultarClickCount = 0;

      const resultsArea = dom.window.document.getElementById('results-area')!;
      // Pestaña seleccionada pero contenedor vacío (sin contenido renderizado ni botón)
      resultsArea.innerHTML = `
        <div class="tab-content">
          <ul class="nav nav-tabs">
            <li id="liCompra"><a id="tabCompra" href="#compra/">COMPRA</a></li>
            <li id="liVenta"><a id="tabVenta" href="#venta/">VENTA</a></li>
          </ul>
          <div id="ventaContainer"></div>
        </div>
      `;

      const fakePage = createFakePageFromDom(dom, () => {
        consultarClickCount++;
        const container = dom.window.document.getElementById('ventaContainer')!;
        container.className = 'tab-pane active';
        container.innerHTML = `
          <table class="table"><tr><td>Factura Venta</td><td>1</td></tr></table>
          <button id="btn-dl-ventas">Descargar Detalles</button>
        `;
      });

      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Ventas',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: true, requireConsultar: true, timeoutMs: 1000, pollIntervalMs: 30 }
      );

      // SÍ debe pulsar Consultar porque no había contenido renderizado
      expect(consultarClickCount).toBe(1);
      expect(inspection.canDownload).toBe(true);
      expect(inspection.activeTabConfirmed).toBe(true);
      expect(inspection.periodConfirmed).toBe(true);
    });

    it('activacion que requiere 2 intentos hasta confirmar', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      const resultsArea = dom.window.document.getElementById('results-area')!;

      // Inicialmente en Compras con sus subpestañas
      resultsArea.innerHTML = `
        <div class="tab-content" id="mainContent">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
            <li id="liVenta"><a id="tabVenta" href="#venta/">VENTA</a></li>
          </ul>
          <ul class="nav nav-pills" id="subtabsCompra">
            <li class="active"><a id="tabRegistro" href="#compraRegistro/">Registro</a></li>
            <li><a href="#compraPendiente/">Pendientes</a></li>
          </ul>
          <div id="compraContainer" class="tab-pane active">
            <button id="btn-dl-compras">Descargar Detalles</button>
          </div>
          <div id="ventaContainer" class="tab-pane" style="display:none;">
            <table class="table"><tr><td>Facturas</td><td>1</td></tr></table>
            <button id="btn-dl-ventas">Descargar Detalles</button>
          </div>
        </div>
      `;

      let switchAttempts = 0;
      const tabVenta = dom.window.document.getElementById('tabVenta')!;

      const applyTransitionToVentas = () => {
        const liCompra = dom.window.document.getElementById('liCompra')!;
        const liVenta = dom.window.document.getElementById('liVenta')!;
        const subtabs = dom.window.document.getElementById('subtabsCompra')!;
        const compraPane = dom.window.document.getElementById('compraContainer')!;
        const ventaPane = dom.window.document.getElementById('ventaContainer')!;

        liCompra.className = '';
        liVenta.className = 'active';
        subtabs.style.display = 'none';
        compraPane.className = 'tab-pane';
        compraPane.style.display = 'none';
        ventaPane.className = 'tab-pane active';
        ventaPane.style.display = 'block';
      };

      // En el 1er intento (click simple), la SPA aún no transiciona (queda en compra).
      // En el 2do intento (click alternado o hashchange), la SPA transiciona a Ventas.
      tabVenta.addEventListener('click', (e) => {
        switchAttempts++;
        if (switchAttempts < 2) {
          e.preventDefault();
        } else {
          applyTransitionToVentas();
        }
      });

      const fakePage = createFakePageFromDom(dom);

      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Ventas',
        undefined,
        { year: 2026, month: 2 },
        { maxActivationAttempts: 3, timeoutMs: 1500, pollIntervalMs: 30 }
      );

      expect(switchAttempts).toBeGreaterThanOrEqual(2);
      expect(inspection.activeTabConfirmed).toBe(true);
      expect(inspection.canDownload).toBe(true);
    });

    it('objetivo VENTA mientras el DOM aun muestra subpestañas de COMPRA -> activeTabConfirmed=false y no se inspecciona/descarga', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      const resultsArea = dom.window.document.getElementById('results-area')!;

      // El usuario o la SPA activó liVenta, PERO el DOM todavía renderiza las subpestañas de compra
      resultsArea.innerHTML = `
        <div class="tab-content" id="mainContent">
          <ul class="nav nav-tabs">
            <li id="liCompra"><a id="tabCompra" href="#compra/">COMPRA</a></li>
            <li id="liVenta" class="active"><a id="tabVenta" href="#venta/">VENTA</a></li>
          </ul>
          <ul class="nav nav-pills" id="subtabsCompra">
            <li class="active"><a id="tabRegistro" href="#compraRegistro/">Registro</a></li>
            <li><a href="#compraPendiente/">Pendientes</a></li>
          </ul>
          <div id="compraContainer" class="tab-pane active">
            <button id="btn-dl-compras">Descargar Detalles</button>
          </div>
        </div>
      `;

      const origDoc = globalThis.document;
      const origWin = globalThis.window;
      let inspection;
      try {
        (globalThis as unknown as { document: Document }).document = dom.window.document;
        (globalThis as unknown as { window: unknown }).window = dom.window;
        inspection = evaluateInspectRcvActiveTab({
          targetTab: 'Ventas',
          expectedPeriod: { year: 2026, month: 2 },
        });
      } finally {
        (globalThis as unknown as { document: Document }).document = origDoc;
        (globalThis as unknown as { window: unknown }).window = origWin;
      }

      // Regla de seguridad estricta: NO confirma pestaña y NO habilita descarga de la pestaña equivocada
      expect(inspection.activeTabConfirmed).toBe(false);
      expect(inspection.hasDownloadButton).toBe(false);
      expect(inspection.subtabRegistroFound).toBe(true);
      expect(inspection.subtabRegistroActive).toBe(true);
    });

    it('tras confirmar, se detecta el boton correcto excluyendo resumenes y boletas', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      const resultsArea = dom.window.document.getElementById('results-area')!;

      // Venta activada y confirmada positivamente: sin subpestañas de compra, con boletas y resumen
      resultsArea.innerHTML = `
        <div class="tab-content" id="ventaResults">
          <ul class="nav nav-tabs">
            <li id="liCompra"><a id="tabCompra" href="#compra/">COMPRA</a></li>
            <li id="liVenta" class="active"><a id="tabVenta" href="#venta/">VENTA</a></li>
          </ul>
          <div id="ventaContainer" class="tab-pane active">
            <table class="table"><tr><td>Facturas Emitidas</td><td>1</td></tr></table>
            <button id="btn-boletas">Descargar Boletas Electronicas</button>
            <button id="btn-resumen">Descargar Resumenes</button>
            <button id="btn-dl-detalles">Descargar Detalles</button>
          </div>
        </div>
      `;

      const origDoc = globalThis.document;
      const origWin = globalThis.window;
      let inspection;
      try {
        (globalThis as unknown as { document: Document }).document = dom.window.document;
        (globalThis as unknown as { window: unknown }).window = dom.window;
        inspection = evaluateInspectRcvActiveTab({
          targetTab: 'Ventas',
          expectedPeriod: { year: 2026, month: 2 },
        });
      } finally {
        (globalThis as unknown as { document: Document }).document = origDoc;
        (globalThis as unknown as { window: unknown }).window = origWin;
      }

      expect(inspection.activeTabConfirmed).toBe(true);
      expect(inspection.hasDownloadButton).toBe(true);
      expect(inspection.detalleButtonFound).toBe(true);
      expect(inspection.detalleButtonVisible).toBe(true);
      expect(inspection.downloadButtonsFound).toBe(3);
      expect(inspection.downloadButtonLabels).toContain('descargar detalles');
    });

    it('codigo TAB_ACTIVATION_FAILED cuando nunca se confirma la pestaña objetivo', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      const resultsArea = dom.window.document.getElementById('results-area')!;

      // Se solicita Ventas pero el DOM permanece irrevocablemente en Compras con sus subpestañas
      resultsArea.innerHTML = `
        <div class="tab-content" id="mainContent">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
            <li id="liVenta"><a id="tabVenta" href="#venta/">VENTA</a></li>
          </ul>
          <ul class="nav nav-pills" id="subtabsCompra">
            <li class="active"><a id="tabRegistro" href="#compraRegistro/">Registro</a></li>
          </ul>
          <div id="compraContainer" class="tab-pane active">
            <button id="btn-dl-compras">Descargar Detalles</button>
          </div>
        </div>
      `;

      const fakePage = createFakePageFromDom(dom);

      let caughtErr: unknown;
      try {
        await selectAndInspectRcvTab(
          fakePage,
          'Ventas',
          undefined,
          { year: 2026, month: 2 },
          { maxActivationAttempts: 2, timeoutMs: 300, pollIntervalMs: 30 }
        );
      } catch (err) {
        caughtErr = err;
      }

      expect(caughtErr).toBeInstanceOf(AppError);
      const appErr = caughtErr as AppError;
      expect(appErr.code).toBe('TAB_ACTIVATION_FAILED');
      expect(appErr.stage).toBe('tab_selection');
      expect(appErr.details?.tabDiagnostic).toBeDefined();
      const diag = appErr.details!.tabDiagnostic as RcvTabDiagnostic;
      expect(diag.activeTabConfirmed).toBe(false);
      expect(diag.subtabRegistroFound).toBe(true);
    });

    it('genera tabDiagnostic estructural seguro en escenario sin botón y excluye absolutamente texto de la página', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      dom.window.location.hash = '#compraRegistro/';

      const resultsArea = dom.window.document.getElementById('results-area')!;
      // Escenario donde COMPRA tiene la subpestaña Registro activa, 2 tablas con datos fiscales privados
      // (RUT, folios, montos, razón social) y un botón 'Descargar Resumen' (pero NUNCA 'Descargar Detalles')
      resultsArea.innerHTML = `
        <div class="tab-content" id="compraContent">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
            <li id="liVenta"><a id="tabVenta" href="#venta/">VENTA</a></li>
          </ul>
          <ul class="nav nav-pills subtabs">
            <li id="subtabLiRegistro"><a id="tabRegistro" href="#compraRegistro/">Registro</a></li>
            <li><a href="#compraPendiente/">Pendientes</a></li>
          </ul>
          <div id="compraContainer" class="tab-pane active">
            <!-- Texto privado, folios, montos y RUT que NUNCA deben aparecer en tabDiagnostic -->
            <table class="table">
              <thead><tr><th>RUT Proveedor</th><th>Razón Social</th><th>Folio</th><th>Monto Total</th></tr></thead>
              <tbody>
                <tr><td>76.999.888-K</td><td>EMPRESA CONFIDENCIAL SPA</td><td>123456</td><td>$99.990.000</td></tr>
              </tbody>
            </table>
            <table class="table secondary">
              <tbody><tr><td>Total Crédito Fiscal Recuperable: $18.998.100</td></tr></tbody>
            </table>
            <!-- Solo expone Descargar Resumen, no Descargar Detalles -->
            <button id="btn-resumen" class="btn btn-default">Descargar Resumen</button>
          </div>
        </div>
      `;

      const fakePage = createFakePageFromDom(dom);

      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );

      // 1. Debe indicar que no puede descargar (fail-closed)
      expect(inspection.canDownload).toBe(false);
      expect(inspection.hasNoMovements).toBe(false);
      expect(inspection.activeTabConfirmed).toBe(true);
      expect(inspection.periodConfirmed).toBe(true);

      // 2. tabDiagnostic debe estar presente
      expect(inspection.tabDiagnostic).toBeDefined();
      const diag = inspection.tabDiagnostic!;

      // 3. Verificación exacta de señales estructurales requeridas
      expect(diag.activeTabConfirmed).toBe(true);
      expect(diag.periodConfirmed).toBe(true);
      expect(diag.subtabRegistroFound).toBe(true);
      expect(diag.subtabRegistroActive).toBe(true);
      expect(diag.downloadButtonsFound).toBe(1); // Detectó el botón 'Descargar Resumen'
      expect(diag.detalleButtonFound).toBe(false); // No existe botón de detalles
      expect(diag.detalleButtonVisible).toBe(false);
      expect(diag.tableCount).toBe(2); // Dos tablas presentes
      expect(diag.noMovementsPatternFound).toBe(false);
      expect(typeof diag.consultarClicked).toBe('boolean');
      expect(diag.hashEndsWith).toBe('#compraRegistro/');
      expect(diag.elapsedMsInTab).toBeGreaterThanOrEqual(0);

      // 4. Claves exclusivas permitidas: exactamente las 15 señales estructurales requeridas
      const expectedKeys = [
        'activeTabConfirmed',
        'consultarClicked',
        'detalleButtonFound',
        'detalleButtonVisible',
        'detalleRejectedByOppositeContainer',
        'detalleRejectedBySubtabFilter',
        'detalleRejectedByVisibility',
        'downloadButtonLabels',
        'downloadButtonsFound',
        'elapsedMsInTab',
        'hashEndsWith',
        'noMovementsPatternFound',
        'periodConfirmed',
        'subtabRegistroActive',
        'subtabRegistroFound',
        'tableCount',
      ].sort();
      expect(Object.keys(diag).sort()).toEqual(expectedKeys);
      expect(diag.detalleRejectedByOppositeContainer).toBe(false);
      expect(diag.detalleRejectedByVisibility).toBe(false);
      expect(diag.detalleRejectedBySubtabFilter).toBe(false);
      expect(diag.downloadButtonLabels).toEqual(['descargar resumen']);

      // 5. Verificación estricta de seguridad: NUNCA incluye texto de la página, RUT, folios ni montos
      const serialized = JSON.stringify(diag);
      expect(serialized).not.toContain('76.999.888-K');
      expect(serialized).not.toContain('76999888');
      expect(serialized).not.toContain('EMPRESA CONFIDENCIAL');
      expect(serialized).not.toContain('123456');
      expect(serialized).not.toContain('99.990.000');
      expect(serialized).not.toContain('18.998.100');
      expect(serialized).not.toContain('Crédito Fiscal');
      expect(serialized).not.toContain('Razón Social');
    });

    it('distingue cuando el botón Descargar Detalles existe en el DOM pero no está visible', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      dom.window.location.hash = '#compraRegistro/';

      const resultsArea = dom.window.document.getElementById('results-area')!;
      // El botón de detalles existe pero está oculto con style display: none
      resultsArea.innerHTML = `
        <div class="tab-content" id="compraContent">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
          </ul>
          <ul class="nav nav-pills subtabs">
            <li class="active"><a href="#compraRegistro/">Registro</a></li>
          </ul>
          <div id="compraContainer" class="tab-pane active">
            <table class="table"><tr><td>Factura</td></tr></table>
            <button id="btn-dl-hidden" style="display: none;">Descargar Detalles</button>
          </div>
        </div>
      `;

      const fakePage = createFakePageFromDom(dom);

      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );

      expect(inspection.canDownload).toBe(false);
      expect(inspection.tabDiagnostic).toBeDefined();
      const diag = inspection.tabDiagnostic!;

      // Debe detectar que el botón EXISTE estructuralmente pero NO es visible
      expect(diag.detalleButtonFound).toBe(true);
      expect(diag.detalleButtonVisible).toBe(false);
      expect(diag.downloadButtonsFound).toBe(1);
      expect(diag.tableCount).toBe(1);
    });

    it('detecta patrón de sin movimientos legítimo y marca noMovementsPatternFound: true en tabDiagnostic', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      dom.window.location.hash = '#compraRegistro/';

      const resultsArea = dom.window.document.getElementById('results-area')!;
      resultsArea.innerHTML = `
        <div class="tab-content" id="compraContent">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
          </ul>
          <ul class="nav nav-pills subtabs">
            <li class="active"><a id="tabRegistro" href="#compraRegistro/">Registro</a></li>
          </ul>
          <div id="compraContainer" class="tab-pane active">
            <p class="alert alert-info">No se encontraron registros para el periodo seleccionado</p>
          </div>
        </div>
      `;

      const fakePage = createFakePageFromDom(dom);

      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );

      expect(inspection.hasNoMovements).toBe(true);
      expect(inspection.canDownload).toBe(false);
      expect(inspection.tabDiagnostic).toBeDefined();
      expect(inspection.tabDiagnostic?.noMovementsPatternFound).toBe(true);
      expect(inspection.tabDiagnostic?.tableCount).toBe(0);
      expect(inspection.tabDiagnostic?.detalleButtonFound).toBe(false);
    });

    it('detecta botón con &nbsp; y span anidado en COMPRA', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      dom.window.location.hash = '#compraRegistro/';

      const resultsArea = dom.window.document.getElementById('results-area')!;
      resultsArea.innerHTML = `
        <div class="tab-content" id="compraContent">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
          </ul>
          <ul class="nav nav-pills subtabs">
            <li class="active"><a id="tabRegistro" href="#compraRegistro/">Registro</a></li>
          </ul>
          <div id="compraContainer" class="tab-pane active">
            <table class="table"><tr><td>Factura</td></tr></table>
            <button id="btn-dl-nested" class="btn btn-success">
              &nbsp;Descargar&nbsp;<span>Detalles</span>&nbsp;
            </button>
          </div>
        </div>
      `;

      let clicked = false;
      const btn = dom.window.document.getElementById('btn-dl-nested')!;
      btn.addEventListener('click', () => {
        clicked = true;
      });

      const fakePage = createFakePageFromDom(dom);

      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );

      expect(inspection.canDownload).toBe(true);
      expect(inspection.tabDiagnostic?.detalleButtonFound).toBe(true);
      expect(inspection.tabDiagnostic?.detalleButtonVisible).toBe(true);
      expect(inspection.tabDiagnostic?.downloadButtonLabels).toContain('descargar detalles');

      const clickResult = await fakePage.evaluate(evaluateClickDownloadCsv);
      expect(clickResult).toBe(true);
      expect(clicked).toBe(true);
    });

    it('detecta botón cuyo texto está en aria-label o en atributo value', async () => {
      // Caso 1: aria-label
      const domAria = new JSDOM(buildInitialRcvDom());
      domAria.window.location.hash = '#compraRegistro/';
      const areaAria = domAria.window.document.getElementById('results-area')!;
      areaAria.innerHTML = `
        <div class="tab-content" id="compraContent">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
          </ul>
          <ul class="nav nav-pills subtabs">
            <li class="active"><a href="#compraRegistro/">Registro</a></li>
          </ul>
          <div id="compraContainer" class="tab-pane active">
            <table class="table"><tr><td>Factura</td></tr></table>
            <button id="btn-aria" class="btn btn-default" aria-label="Descargar Detalles">
              <i class="glyphicon glyphicon-download-alt"></i>
            </button>
          </div>
        </div>
      `;

      let ariaClicked = false;
      domAria.window.document.getElementById('btn-aria')!.addEventListener('click', () => {
        ariaClicked = true;
      });

      const fakePageAria = createFakePageFromDom(domAria);
      const inspectionAria = await selectAndInspectRcvTab(
        fakePageAria,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );

      expect(inspectionAria.canDownload).toBe(true);
      expect(inspectionAria.tabDiagnostic?.detalleButtonFound).toBe(true);
      expect(inspectionAria.tabDiagnostic?.detalleButtonVisible).toBe(true);
      expect(inspectionAria.tabDiagnostic?.downloadButtonLabels).toContain('descargar detalles');

      const clickAria = await fakePageAria.evaluate(evaluateClickDownloadCsv);
      expect(clickAria).toBe(true);
      expect(ariaClicked).toBe(true);

      // Caso 2: input[type="button"] con value
      const domValue = new JSDOM(buildInitialRcvDom());
      domValue.window.location.hash = '#compraRegistro/';
      const areaValue = domValue.window.document.getElementById('results-area')!;
      areaValue.innerHTML = `
        <div class="tab-content" id="compraContent">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
          </ul>
          <ul class="nav nav-pills subtabs">
            <li class="active"><a href="#compraRegistro/">Registro</a></li>
          </ul>
          <div id="compraContainer" class="tab-pane active">
            <table class="table"><tr><td>Factura</td></tr></table>
            <input type="button" id="btn-val" value="Descargar Detalle" class="btn" />
          </div>
        </div>
      `;

      let valClicked = false;
      domValue.window.document.getElementById('btn-val')!.addEventListener('click', () => {
        valClicked = true;
      });

      const fakePageValue = createFakePageFromDom(domValue);
      const inspectionValue = await selectAndInspectRcvTab(
        fakePageValue,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );

      expect(inspectionValue.canDownload).toBe(true);
      expect(inspectionValue.tabDiagnostic?.detalleButtonFound).toBe(true);
      expect(inspectionValue.tabDiagnostic?.detalleButtonVisible).toBe(true);
      expect(inspectionValue.tabDiagnostic?.downloadButtonLabels).toContain('descargar detalle');

      const clickVal = await fakePageValue.evaluate(evaluateClickDownloadCsv);
      expect(clickVal).toBe(true);
      expect(valClicked).toBe(true);
    });

    it('nunca selecciona "Descargar Resúmenes" ni "Descargar Boletas Electrónicas" ni subpestañas excluidas', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      dom.window.location.hash = '#compraRegistro/';

      const resultsArea = dom.window.document.getElementById('results-area')!;
      resultsArea.innerHTML = `
        <div class="tab-content" id="compraContent">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
          </ul>
          <ul class="nav nav-pills subtabs">
            <li class="active"><a href="#compraRegistro/">Registro</a></li>
          </ul>
          <div id="compraContainer" class="tab-pane active">
            <table class="table"><tr><td>Factura</td></tr></table>
            <button id="btn-resumenes">Descargar Resúmenes</button>
            <button id="btn-resumen-sing">Descargar Resumen</button>
            <button id="btn-boletas">Descargar Boletas Electrónicas</button>
            <button id="btn-boleta-sing">Descargar Boleta</button>
            <button id="btn-pendientes">Descargar Detalle Pendientes</button>
            <button id="btn-no-incluir">Descargar Detalle No Incluir</button>
            <button id="btn-reclamados">Descargar Detalle Reclamados</button>
          </div>
        </div>
      `;

      let anyClicked = false;
      const buttons = dom.window.document.querySelectorAll('button');
      buttons.forEach((b) => {
        b.addEventListener('click', () => {
          anyClicked = true;
        });
      });

      const fakePage = createFakePageFromDom(dom);
      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );

      expect(inspection.canDownload).toBe(false);
      expect(inspection.tabDiagnostic?.detalleButtonFound).toBe(false);
      expect(inspection.tabDiagnostic?.detalleButtonVisible).toBe(false);

      const clickResult = await fakePage.evaluate(evaluateClickDownloadCsv);
      expect(clickResult).toBe(false);
      expect(anyClicked).toBe(false);
    });

    it('puebla downloadButtonLabels acotado a máximo 5 elementos y 40 caracteres cada uno', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      dom.window.location.hash = '#compraRegistro/';

      const resultsArea = dom.window.document.getElementById('results-area')!;
      resultsArea.innerHTML = `
        <div class="tab-content" id="compraContent">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
          </ul>
          <ul class="nav nav-pills subtabs">
            <li class="active"><a href="#compraRegistro/">Registro</a></li>
          </ul>
          <div id="compraContainer" class="tab-pane active">
            <table class="table"><tr><td>Factura</td></tr></table>
            <button id="btn1">Descargar Detalle del Registro Completo de Compras Periodo 2026</button>
            <button id="btn2">Descargar Resumen Oficial</button>
            <button id="btn3">Descargar Boletas Electrónicas</button>
            <button id="btn4">Descargar Pendientes</button>
            <button id="btn5">Descargar No Incluir</button>
            <button id="btn6">Descargar Reclamados</button>
            <button id="btn7">Ver Detalles</button>
          </div>
        </div>
      `;

      const fakePage = createFakePageFromDom(dom);
      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );

      expect(inspection.tabDiagnostic).toBeDefined();
      const diag = inspection.tabDiagnostic!;

      // 6 botones empezaban por 'descargar'
      expect(diag.downloadButtonsFound).toBe(6);

      // downloadButtonLabels debe contener exactamente 5 elementos (acotado a 5)
      expect(diag.downloadButtonLabels).toBeDefined();
      expect(diag.downloadButtonLabels!.length).toBe(5);

      // Cada elemento debe tener máximo 40 caracteres
      for (const label of diag.downloadButtonLabels!) {
        expect(label.length).toBeLessThanOrEqual(40);
        expect(label.startsWith('descargar')).toBe(true);
      }

      // El primer botón debe estar truncado a 40 caracteres
      expect(diag.downloadButtonLabels![0].length).toBe(40);
      expect(diag.downloadButtonLabels![0]).toBe(
        'descargar detalle del registro completo de compras periodo 2026'.slice(0, 40)
      );

      // El botón 7 ('Ver Detalles') no debe figurar
      for (const label of diag.downloadButtonLabels!) {
        expect(label).not.toContain('ver detalles');
      }
    });

    it('boton de COMPRA dentro de contenedores con clases genericas ng-scope/col-md-6 NO debe excluirse', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      dom.window.location.hash = '#compraRegistro/';

      const resultsArea = dom.window.document.getElementById('results-area')!;
      resultsArea.innerHTML = `
        <div class="tab-content" id="compraContent">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
            <li id="liVenta"><a id="tabVenta" href="#venta/">VENTA</a></li>
          </ul>
          <ul class="nav nav-pills subtabs">
            <li class="active"><a href="#compraRegistro/">Registro</a></li>
          </ul>
          <div class="ng-scope col-md-6 ng-isolate-scope">
            <div class="row col-xs-12 ng-scope">
              <table class="table"><tr><td>Factura Compra</td></tr></table>
              <button id="btn-compra-generic" class="btn btn-primary ng-binding col-md-6">Descargar Detalles</button>
            </div>
          </div>
        </div>
      `;

      let clicked = false;
      const btn = dom.window.document.getElementById('btn-compra-generic')!;
      btn.addEventListener('click', () => {
        clicked = true;
      });

      const fakePage = createFakePageFromDom(dom);

      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );

      expect(inspection.canDownload).toBe(true);
      expect(inspection.tabDiagnostic?.detalleButtonFound).toBe(true);
      expect(inspection.tabDiagnostic?.detalleButtonVisible).toBe(true);
      expect(inspection.tabDiagnostic?.detalleRejectedByOppositeContainer).toBe(false);
      expect(inspection.tabDiagnostic?.detalleRejectedByVisibility).toBe(false);
      expect(inspection.tabDiagnostic?.downloadButtonLabels).toContain('descargar detalles');

      const clickResult = await fakePage.evaluate(evaluateClickDownloadCsv);
      expect(clickResult).toBe(true);
      expect(clicked).toBe(true);
    });

    it('boton realmente dentro de un contenedor id=\'venta\' oculto SI debe excluirse cuando se inspecciona compras', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      dom.window.location.hash = '#compraRegistro/';

      const resultsArea = dom.window.document.getElementById('results-area')!;
      resultsArea.innerHTML = `
        <div class="tab-content">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
            <li id="liVenta"><a id="tabVenta" href="#venta/">VENTA</a></li>
          </ul>
          <ul class="nav nav-pills subtabs">
            <li class="active"><a href="#compraRegistro/">Registro</a></li>
          </ul>
          <div id="compraContainer" class="tab-pane active">
            <table class="table"><tr><td>Factura Compra</td></tr></table>
          </div>
          <!-- Contenedor inequívoco de venta, oculto -->
          <div id="venta" style="display: none;">
            <button id="btn-venta-hidden">Descargar Detalles</button>
          </div>
        </div>
      `;

      let ventaClicked = false;
      const btnVenta = dom.window.document.getElementById('btn-venta-hidden')!;
      btnVenta.addEventListener('click', () => {
        ventaClicked = true;
      });

      const fakePage = createFakePageFromDom(dom);

      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );

      expect(inspection.canDownload).toBe(false);
      expect(inspection.tabDiagnostic?.detalleButtonFound).toBe(false);
      expect(inspection.tabDiagnostic?.detalleButtonVisible).toBe(false);
      expect(inspection.tabDiagnostic?.detalleRejectedByOppositeContainer).toBe(true);
      expect(inspection.tabDiagnostic?.detalleRejectedByVisibility).toBe(false);

      const clickResult = await fakePage.evaluate(evaluateClickDownloadCsv);
      expect(clickResult).toBe(false);
      expect(ventaClicked).toBe(false);
    });

    it('los dos nuevos flags detalleRejectedByOppositeContainer y detalleRejectedByVisibility se rellenan correctamente en todos los casos', async () => {
      // Caso A: Botón de detalles en pestaña activa pero oculto por style display: none
      const domHidden = new JSDOM(buildInitialRcvDom());
      domHidden.window.location.hash = '#compraRegistro/';
      const areaHidden = domHidden.window.document.getElementById('results-area')!;
      areaHidden.innerHTML = `
        <div class="tab-content" id="compraContent">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
          </ul>
          <ul class="nav nav-pills subtabs">
            <li class="active"><a href="#compraRegistro/">Registro</a></li>
          </ul>
          <div id="compraContainer" class="tab-pane active">
            <table class="table"><tr><td>Factura</td></tr></table>
            <button id="btn-hidden" style="display: none;">Descargar Detalles</button>
          </div>
        </div>
      `;
      const pageHidden = createFakePageFromDom(domHidden);
      const resHidden = await selectAndInspectRcvTab(
        pageHidden,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );
      expect(resHidden.tabDiagnostic?.detalleButtonFound).toBe(true);
      expect(resHidden.tabDiagnostic?.detalleButtonVisible).toBe(false);
      expect(resHidden.tabDiagnostic?.detalleRejectedByOppositeContainer).toBe(false);
      expect(resHidden.tabDiagnostic?.detalleRejectedByVisibility).toBe(true);

      // Caso B: Botón dentro de contenedor inequívoco de venta oculto con aria-hidden
      const domAriaHidden = new JSDOM(buildInitialRcvDom());
      domAriaHidden.window.location.hash = '#compraRegistro/';
      const areaAriaHidden = domAriaHidden.window.document.getElementById('results-area')!;
      areaAriaHidden.innerHTML = `
        <div class="tab-content">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
          </ul>
          <ul class="nav nav-pills subtabs">
            <li class="active"><a href="#compraRegistro/">Registro</a></li>
          </ul>
          <div id="compraContainer" class="tab-pane active">
            <table class="table"><tr><td>Factura</td></tr></table>
          </div>
          <div id="ventasContainer" aria-hidden="true">
            <button id="btn-opp-aria">Descargar Detalles</button>
          </div>
        </div>
      `;
      const pageAriaHidden = createFakePageFromDom(domAriaHidden);
      const resAriaHidden = await selectAndInspectRcvTab(
        pageAriaHidden,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );
      expect(resAriaHidden.tabDiagnostic?.detalleButtonFound).toBe(false);
      expect(resAriaHidden.tabDiagnostic?.detalleButtonVisible).toBe(false);
      expect(resAriaHidden.tabDiagnostic?.detalleRejectedByOppositeContainer).toBe(true);
      expect(resAriaHidden.tabDiagnostic?.detalleRejectedByVisibility).toBe(false);

      // Caso C: Botón visible y válido en pestaña activa
      const domVisible = new JSDOM(buildInitialRcvDom());
      domVisible.window.location.hash = '#compraRegistro/';
      const areaVisible = domVisible.window.document.getElementById('results-area')!;
      areaVisible.innerHTML = `
        <div class="tab-content" id="compraContent">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
          </ul>
          <ul class="nav nav-pills subtabs">
            <li class="active"><a href="#compraRegistro/">Registro</a></li>
          </ul>
          <div id="compraContainer" class="tab-pane active">
            <table class="table"><tr><td>Factura</td></tr></table>
            <button id="btn-ok">Descargar Detalles</button>
          </div>
        </div>
      `;
      const pageVisible = createFakePageFromDom(domVisible);
      const resVisible = await selectAndInspectRcvTab(
        pageVisible,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );
      expect(resVisible.tabDiagnostic?.detalleButtonFound).toBe(true);
      expect(resVisible.tabDiagnostic?.detalleButtonVisible).toBe(true);
      expect(resVisible.tabDiagnostic?.detalleRejectedByOppositeContainer).toBe(false);
      expect(resVisible.tabDiagnostic?.detalleRejectedByVisibility).toBe(false);

      // Caso D: Sin botón de detalles
      const domNone = new JSDOM(buildInitialRcvDom());
      domNone.window.location.hash = '#compraRegistro/';
      const areaNone = domNone.window.document.getElementById('results-area')!;
      areaNone.innerHTML = `
        <div class="tab-content" id="compraContent">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
          </ul>
          <ul class="nav nav-pills subtabs">
            <li class="active"><a href="#compraRegistro/">Registro</a></li>
          </ul>
          <div id="compraContainer" class="tab-pane active">
            <table class="table"><tr><td>Factura</td></tr></table>
          </div>
        </div>
      `;
      const pageNone = createFakePageFromDom(domNone);
      const resNone = await selectAndInspectRcvTab(
        pageNone,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );
      expect(resNone.tabDiagnostic?.detalleButtonFound).toBe(false);
      expect(resNone.tabDiagnostic?.detalleButtonVisible).toBe(false);
      expect(resNone.tabDiagnostic?.detalleRejectedByOppositeContainer).toBe(false);
      expect(resNone.tabDiagnostic?.detalleRejectedByVisibility).toBe(false);
    });

    it('boton de COMPRA cuyo ancestro tiene id que contiene "venta" (p.ej id="compraventaContainer") NO debe excluirse', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      dom.window.location.hash = '#compraRegistro/';

      const resultsArea = dom.window.document.getElementById('results-area')!;
      resultsArea.innerHTML = `
        <div class="tab-content" id="compraContent">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
            <li id="liVenta"><a id="tabVenta" href="#venta/">VENTA</a></li>
          </ul>
          <ul class="nav nav-pills subtabs">
            <li class="active"><a href="#compraRegistro/">Registro</a></li>
          </ul>
          <div id="compraventaContainer" class="tab-pane active">
            <table class="table"><tr><td>Factura Compra</td></tr></table>
            <button id="btn-compra-cv">Descargar Detalles</button>
          </div>
        </div>
      `;

      let clicked = false;
      const btn = dom.window.document.getElementById('btn-compra-cv')!;
      btn.addEventListener('click', () => {
        clicked = true;
      });

      const fakePage = createFakePageFromDom(dom);

      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );

      expect(inspection.canDownload).toBe(true);
      expect(inspection.tabDiagnostic?.detalleButtonFound).toBe(true);
      expect(inspection.tabDiagnostic?.detalleButtonVisible).toBe(true);
      expect(inspection.tabDiagnostic?.detalleRejectedByOppositeContainer).toBe(false);
      expect(inspection.tabDiagnostic?.detalleRejectedBySubtabFilter).toBe(false);
      expect(inspection.tabDiagnostic?.detalleRejectedByVisibility).toBe(false);
      expect(inspection.tabDiagnostic?.downloadButtonLabels).toContain('descargar detalles');

      const clickResult = await fakePage.evaluate(evaluateClickDownloadCsv);
      expect(clickResult).toBe(true);
      expect(clicked).toBe(true);
    });

    it('simetrico para VENTA con id que contiene "compra" (p.ej id="compraventaContainer") NO debe excluirse', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      dom.window.location.hash = '#venta/';

      const resultsArea = dom.window.document.getElementById('results-area')!;
      resultsArea.innerHTML = `
        <div class="tab-content" id="ventaContent">
          <ul class="nav nav-tabs">
            <li id="liCompra"><a id="tabCompra" href="#compra/">COMPRA</a></li>
            <li id="liVenta" class="active"><a id="tabVenta" href="#venta/">VENTA</a></li>
          </ul>
          <div id="compraventaContainer" class="tab-pane active">
            <table class="table"><tr><td>Factura Venta</td></tr></table>
            <button id="btn-venta-cv">Descargar Detalles</button>
          </div>
        </div>
      `;

      let clicked = false;
      const btn = dom.window.document.getElementById('btn-venta-cv')!;
      btn.addEventListener('click', () => {
        clicked = true;
      });

      const fakePage = createFakePageFromDom(dom);

      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Ventas',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );

      expect(inspection.canDownload).toBe(true);
      expect(inspection.tabDiagnostic?.detalleButtonFound).toBe(true);
      expect(inspection.tabDiagnostic?.detalleButtonVisible).toBe(true);
      expect(inspection.tabDiagnostic?.detalleRejectedByOppositeContainer).toBe(false);
      expect(inspection.tabDiagnostic?.detalleRejectedBySubtabFilter).toBe(false);
      expect(inspection.tabDiagnostic?.detalleRejectedByVisibility).toBe(false);
      expect(inspection.tabDiagnostic?.downloadButtonLabels).toContain('descargar detalles');

      const clickResult = await fakePage.evaluate(evaluateClickDownloadCsv);
      expect(clickResult).toBe(true);
      expect(clicked).toBe(true);
    });

    it('boton en subpestaña Pendientes/Reclamados SI excluido y registra detalleRejectedBySubtabFilter', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      dom.window.location.hash = '#compraRegistro/';

      const resultsArea = dom.window.document.getElementById('results-area')!;
      resultsArea.innerHTML = `
        <div class="tab-content" id="compraContent">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
          </ul>
          <ul class="nav nav-pills subtabs">
            <li class="active"><a href="#compraRegistro/">Registro</a></li>
          </ul>
          <div id="compraContainer" class="tab-pane active">
            <table class="table"><tr><td>Factura Registro</td></tr></table>
          </div>
          <!-- Subpestaña de pendientes con botón de detalles oculta efectivamente -->
          <div id="pendientes" class="tab-pane" style="display: none;">
            <button id="btn-pendientes">Descargar Detalles</button>
          </div>
          <div id="reclamados" class="tab-pane" style="display: none;">
            <button id="btn-reclamados">Descargar Detalles</button>
          </div>
        </div>
      `;

      let pendientesClicked = false;
      dom.window.document.getElementById('btn-pendientes')!.addEventListener('click', () => {
        pendientesClicked = true;
      });

      const fakePage = createFakePageFromDom(dom);

      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );

      expect(inspection.canDownload).toBe(false);
      expect(inspection.tabDiagnostic?.detalleButtonFound).toBe(false);
      expect(inspection.tabDiagnostic?.detalleButtonVisible).toBe(false);
      expect(inspection.tabDiagnostic?.detalleRejectedBySubtabFilter).toBe(true);
      expect(inspection.tabDiagnostic?.downloadButtonLabels).not.toContain('descargar detalles');

      const clickResult = await fakePage.evaluate(evaluateClickDownloadCsv);
      expect(clickResult).toBe(false);
      expect(pendientesClicked).toBe(false);
    });

    it('asegura coherencia estricta entre downloadButtonLabels y detalleButtonFound', async () => {
      // Escenario 1: Botón exclusivo en subpestaña excluida -> detalleButtonFound=false y downloadButtonLabels NO lo contiene
      const domSub = new JSDOM(buildInitialRcvDom());
      domSub.window.location.hash = '#compraRegistro/';
      const areaSub = domSub.window.document.getElementById('results-area')!;
      areaSub.innerHTML = `
        <div class="tab-content" id="compraContent">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
          </ul>
          <ul class="nav nav-pills subtabs">
            <li class="active"><a href="#compraRegistro/">Registro</a></li>
          </ul>
          <div id="compraContainer" class="tab-pane active">
            <table class="table"><tr><td>Factura</td></tr></table>
            <button id="btn-res">Descargar Resumen</button>
          </div>
          <div id="reclamados" class="tab-pane" style="display: none;">
            <button id="btn-reclamados-det">Descargar Detalles</button>
          </div>
        </div>
      `;
      const pageSub = createFakePageFromDom(domSub);
      const resSub = await selectAndInspectRcvTab(
        pageSub,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );
      // 'descargar detalles' fue rechazado por filtro de subpestaña
      expect(resSub.tabDiagnostic?.detalleButtonFound).toBe(false);
      expect(resSub.tabDiagnostic?.detalleRejectedBySubtabFilter).toBe(true);
      // Coherencia: downloadButtonLabels solo contiene 'descargar resumen', NUNCA 'descargar detalles'
      expect(resSub.tabDiagnostic?.downloadButtonLabels).toEqual(['descargar resumen']);
      expect(resSub.tabDiagnostic?.downloadButtonLabels).not.toContain('descargar detalles');

      // Escenario 2: Botón legítimo presente en pestaña activa -> detalleButtonFound=true y downloadButtonLabels SÍ lo contiene
      const domOk = new JSDOM(buildInitialRcvDom());
      domOk.window.location.hash = '#compraRegistro/';
      const areaOk = domOk.window.document.getElementById('results-area')!;
      areaOk.innerHTML = `
        <div class="tab-content" id="compraContent">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
          </ul>
          <ul class="nav nav-pills subtabs">
            <li class="active"><a href="#compraRegistro/">Registro</a></li>
          </ul>
          <div id="compraContainer" class="tab-pane active">
            <table class="table"><tr><td>Factura</td></tr></table>
            <button id="btn-ok-det">Descargar Detalles</button>
            <button id="btn-ok-res">Descargar Resumen</button>
          </div>
        </div>
      `;
      const pageOk = createFakePageFromDom(domOk);
      const resOk = await selectAndInspectRcvTab(
        pageOk,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );
      expect(resOk.tabDiagnostic?.detalleButtonFound).toBe(true);
      expect(resOk.tabDiagnostic?.detalleButtonVisible).toBe(true);
      expect(resOk.tabDiagnostic?.detalleRejectedBySubtabFilter).toBe(false);
      // Coherencia: si detalleButtonFound es true, downloadButtonLabels incluye 'descargar detalles'
      expect(resOk.tabDiagnostic?.downloadButtonLabels).toContain('descargar detalles');
      expect(resOk.tabDiagnostic?.downloadButtonLabels).toContain('descargar resumen');
    });

    it('estructura real COMPRA: contenedor con menu completo de subpestañas y botones fuera de panel excluido detecta detalles y puebla downloadButtonLabels', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      dom.window.location.hash = '#compraRegistro/';

      const resultsArea = dom.window.document.getElementById('results-area')!;
      resultsArea.innerHTML = `
        <div id="compraContainer" class="main-compra-wrapper">
          <!-- Menu completo de subpestañas presentes como hermanos en el contenedor de COMPRA -->
          <ul class="nav nav-tabs subtabs-menu" id="menuSubtabsCompra">
            <li class="active"><a id="subtabRegistro" href="#compraRegistro/">Registro</a></li>
            <li><a id="subtabPendientes" href="#compraPendientes/">Pendientes</a></li>
            <li><a id="subtabNoIncluir" href="#compraNoIncluir/">No Incluir</a></li>
            <li><a id="subtabReclamados" href="#compraReclamados/">Reclamados</a></li>
          </ul>
          <div class="tabla-container">
            <table class="table"><thead><tr><th>Documentos Registro</th></tr></thead><tbody><tr><td>Factura</td></tr></tbody></table>
          </div>
          <!-- Botones de descarga de Registro fuera de cualquier panel de subpestaña excluida -->
          <div class="descargas-wrapper">
            <button id="btnDescargarResumenes" class="btn btn-default">Descargar Resúmenes</button>
            <button id="btnDescargarDetalles" class="btn btn-primary">Descargar Detalles</button>
          </div>
          <!-- Paneles de subpestañas excluidas existentes en el DOM pero separados -->
          <div id="pendientes" class="tab-pane" style="display: none;"></div>
          <div id="reclamados" class="tab-pane" style="display: none;"></div>
          <div id="noincluir" class="tab-pane" style="display: none;"></div>
        </div>
      `;

      let detalleClicked = false;
      dom.window.document.getElementById('btnDescargarDetalles')!.addEventListener('click', () => {
        detalleClicked = true;
      });

      const fakePage = createFakePageFromDom(dom);
      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );

      expect(inspection.canDownload).toBe(true);
      expect(inspection.tabDiagnostic?.detalleButtonFound).toBe(true);
      expect(inspection.tabDiagnostic?.detalleButtonVisible).toBe(true);
      expect(inspection.tabDiagnostic?.detalleRejectedBySubtabFilter).toBe(false);
      expect(inspection.tabDiagnostic?.downloadButtonsFound).toBe(2);
      expect(inspection.tabDiagnostic?.downloadButtonLabels).toContain('descargar resumenes');
      expect(inspection.tabDiagnostic?.downloadButtonLabels).toContain('descargar detalles');

      const clickResult = await fakePage.evaluate(evaluateClickDownloadCsv);
      expect(clickResult).toBe(true);
      expect(detalleClicked).toBe(true);
    });

    it('boton dentro de un panel id="pendientes" es excluido y registra detalleRejectedBySubtabFilter=true', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      dom.window.location.hash = '#compraRegistro/';

      const resultsArea = dom.window.document.getElementById('results-area')!;
      resultsArea.innerHTML = `
        <div id="compraContainer">
          <ul class="nav nav-tabs">
            <li class="active"><a href="#compraRegistro/">Registro</a></li>
            <li><a href="#compraPendientes/">Pendientes</a></li>
          </ul>
          <div class="tabla-container">
            <table class="table"><tr><td>Factura</td></tr></table>
          </div>
          <!-- Botón de detalles ubicado realmente dentro de panel de subpestaña excluida oculta -->
          <div id="pendientes" class="tab-pane" style="display: none;">
            <button id="btn-det-pendientes">Descargar Detalles</button>
          </div>
        </div>
      `;

      let clicked = false;
      dom.window.document.getElementById('btn-det-pendientes')!.addEventListener('click', () => {
        clicked = true;
      });

      const fakePage = createFakePageFromDom(dom);
      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );

      expect(inspection.canDownload).toBe(false);
      expect(inspection.tabDiagnostic?.detalleButtonFound).toBe(false);
      expect(inspection.tabDiagnostic?.detalleRejectedBySubtabFilter).toBe(true);
      expect(inspection.tabDiagnostic?.downloadButtonLabels).not.toContain('descargar detalles');

      const clickResult = await fakePage.evaluate(evaluateClickDownloadCsv);
      expect(clickResult).toBe(false);
      expect(clicked).toBe(false);
    });

    it('estructura REAL SPA COMPRA: panel id="pendiente" tab-pane visible sin active con dos botones y panel id="home" active vacio detecta detalles y lo pulsa', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      dom.window.location.hash = '#compraRegistro/';

      const resultsArea = dom.window.document.getElementById('results-area')!;
      resultsArea.innerHTML = `
        <div class="tab-content" id="compraContent">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
          </ul>
          <!-- Panel id="home" activo pero vacio sin botones de descarga (evidencia real SPA SII) -->
          <div id="home" class="tab-pane active"></div>
          <!-- Contenido real de Registro renderizado en panel id="pendiente" sin clase active pero visible -->
          <div class="ng-scope">
            <div id="pendiente" class="tab-pane" role="tabpanel" style="display: block;">
              <div class="row">
                <div class="col-md-6">
                  <table class="table"><tr><td>Factura Registro</td></tr></table>
                </div>
                <div class="col-md-6">
                  <div class="col-md-6">
                    <button id="btn-real-resumenes">Descargar Resúmenes</button>
                    <button id="btn-real-detalles">Descargar Detalles</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      let detallesClicked = false;
      dom.window.document.getElementById('btn-real-detalles')!.addEventListener('click', () => {
        detallesClicked = true;
      });

      const fakePage = createFakePageFromDom(dom);
      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );

      expect(inspection.canDownload).toBe(true);
      expect(inspection.tabDiagnostic?.detalleButtonFound).toBe(true);
      expect(inspection.tabDiagnostic?.detalleButtonVisible).toBe(true);
      expect(inspection.tabDiagnostic?.detalleRejectedBySubtabFilter).toBe(false);
      expect(inspection.tabDiagnostic?.downloadButtonLabels).toContain('descargar resumenes');
      expect(inspection.tabDiagnostic?.downloadButtonLabels).toContain('descargar detalles');

      const clickResult = await fakePage.evaluate(evaluateClickDownloadCsv);
      expect(clickResult).toBe(true);
      expect(detallesClicked).toBe(true);
    });

    it('boton dentro de un tab-pane con display:none DEBE excluirse y registrar detalleRejectedBySubtabFilter=true', async () => {
      const dom = new JSDOM(buildInitialRcvDom());
      dom.window.location.hash = '#compraRegistro/';

      const resultsArea = dom.window.document.getElementById('results-area')!;
      resultsArea.innerHTML = `
        <div class="tab-content" id="compraContent">
          <ul class="nav nav-tabs">
            <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
          </ul>
          <div id="home" class="tab-pane active">
            <table class="table"><tr><td>Registro Activo</td></tr></table>
          </div>
          <!-- Panel inactivo con display:none conteniendo botón de detalles -->
          <div id="panelOculto" class="tab-pane" role="tabpanel" style="display: none;">
            <button id="btn-hidden-detalle">Descargar Detalles</button>
          </div>
        </div>
      `;

      let hiddenClicked = false;
      dom.window.document.getElementById('btn-hidden-detalle')!.addEventListener('click', () => {
        hiddenClicked = true;
      });

      const fakePage = createFakePageFromDom(dom);
      const inspection = await selectAndInspectRcvTab(
        fakePage,
        'Compras',
        undefined,
        { year: 2026, month: 2 },
        { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
      );

      expect(inspection.canDownload).toBe(false);
      expect(inspection.tabDiagnostic?.detalleButtonFound).toBe(false);
      expect(inspection.tabDiagnostic?.detalleButtonVisible).toBe(false);
      expect(inspection.tabDiagnostic?.detalleRejectedBySubtabFilter).toBe(true);
      expect(inspection.tabDiagnostic?.downloadButtonLabels).not.toContain('descargar detalles');

      const clickResult = await fakePage.evaluate(evaluateClickDownloadCsv);
      expect(clickResult).toBe(false);
      expect(hiddenClicked).toBe(false);
    });

    describe('Dato real portal SII: recuadro rosado sin información de Registro / Ventas (ej. periodo vacío)', () => {
      it('reproduce caso real VENTA vacía: recuadro rosado con "No hay información de Ventas." sin botones -> hasNoMovements=true, canDownload=false y status empty', async () => {
        const dom = new JSDOM(buildInitialRcvDom());
        dom.window.location.hash = '#venta/';

        const resultsArea = dom.window.document.getElementById('results-area')!;
        // Estructura real reportada por usuario: sin botones inferiores (ni Detalles ni Resumenes)
        // y con recuadro rosado con el texto exacto 'No hay información de Ventas.'
        resultsArea.innerHTML = `
          <div class="tab-content" id="ventaContent">
            <ul class="nav nav-tabs">
              <li id="liCompra"><a id="tabCompra" href="#compra/">COMPRA</a></li>
              <li id="liVenta" class="active"><a id="tabVenta" href="#venta/">VENTA</a></li>
            </ul>
            <div id="ventaContainer" class="tab-pane active">
              <div class="alert alert-danger" style="background-color: #f2dede; border-color: #ebccd1; color: #a94442;">
                No hay información de Ventas.
              </div>
            </div>
          </div>
        `;

        const fakePage = createFakePageFromDom(dom);
        const inspection = await selectAndInspectRcvTab(
          fakePage,
          'Ventas',
          undefined,
          { year: 2026, month: 2 },
          { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
        );

        expect(inspection.hasNoMovements).toBe(true);
        expect(inspection.canDownload).toBe(false);
        expect(inspection.periodConfirmed).toBe(true);
        expect(inspection.activeTabConfirmed).toBe(true);
        expect(inspection.tabDiagnostic?.noMovementsPatternFound).toBe(true);
        expect(inspection.tabDiagnostic?.downloadButtonsFound).toBe(0);
        expect(inspection.tabDiagnostic?.detalleButtonFound).toBe(false);

        // Flujo del provider hacia registro: status 'empty'
        const recordStatus = inspection.hasNoMovements ? 'empty' : (inspection.canDownload ? 'ok' : 'error');
        expect(recordStatus).toBe('empty');
      });

      it('reproduce caso real COMPRA vacía: subpestaña Registro con "No hay información de Registro." sin botones -> hasNoMovements=true, canDownload=false y status empty', async () => {
        const dom = new JSDOM(buildInitialRcvDom());
        dom.window.location.hash = '#compraRegistro/';

        const resultsArea = dom.window.document.getElementById('results-area')!;
        // Estructura real reportada por usuario en COMPRA>Registro: sin botones inferiores
        // y con recuadro rosado con el texto exacto 'No hay información de Registro.'
        resultsArea.innerHTML = `
          <div class="tab-content" id="compraContent">
            <ul class="nav nav-tabs">
              <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
              <li id="liVenta"><a id="tabVenta" href="#venta/">VENTA</a></li>
            </ul>
            <ul class="nav nav-pills subtabs">
              <li class="active"><a id="tabRegistro" href="#compraRegistro/">Registro</a></li>
              <li><a id="tabPendientes" href="#compraPendiente/">Pendientes</a></li>
            </ul>
            <div id="compraContainer" class="tab-pane active">
              <div class="alert alert-danger" style="background-color: #f2dede; border-color: #ebccd1; color: #a94442;">
                No hay información de Registro.
              </div>
            </div>
          </div>
        `;

        const fakePage = createFakePageFromDom(dom);
        const inspection = await selectAndInspectRcvTab(
          fakePage,
          'Compras',
          undefined,
          { year: 2026, month: 2 },
          { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
        );

        expect(inspection.hasNoMovements).toBe(true);
        expect(inspection.canDownload).toBe(false);
        expect(inspection.periodConfirmed).toBe(true);
        expect(inspection.activeTabConfirmed).toBe(true);
        expect(inspection.tabDiagnostic?.noMovementsPatternFound).toBe(true);
        expect(inspection.tabDiagnostic?.downloadButtonsFound).toBe(0);
        expect(inspection.tabDiagnostic?.detalleButtonFound).toBe(false);

        // Flujo del provider hacia registro: status 'empty'
        const recordStatus = inspection.hasNoMovements ? 'empty' : (inspection.canDownload ? 'ok' : 'error');
        expect(recordStatus).toBe('empty');
      });

      it('caso sin botones y SIN mensaje -> mantiene fail-closed: canDownload=false, hasNoMovements=false y error RCV_DOWNLOAD_UNAVAILABLE (nunca empty)', async () => {
        const dom = new JSDOM(buildInitialRcvDom());
        dom.window.location.hash = '#compraRegistro/';

        const resultsArea = dom.window.document.getElementById('results-area')!;
        // Pestaña y período confirmados, SIN botones inferiores y SIN mensaje de sin movimientos
        resultsArea.innerHTML = `
          <div class="tab-content" id="compraContent">
            <ul class="nav nav-tabs">
              <li id="liCompra" class="active"><a id="tabCompra" href="#compra/">COMPRA</a></li>
              <li id="liVenta"><a id="tabVenta" href="#venta/">VENTA</a></li>
            </ul>
            <ul class="nav nav-pills subtabs">
              <li class="active"><a id="tabRegistro" href="#compraRegistro/">Registro</a></li>
            </ul>
            <div id="compraContainer" class="tab-pane active">
              <table class="table">
                <thead><tr><th>Columna</th></tr></thead>
                <tbody><tr><td>Dato</td></tr></tbody>
              </table>
              <!-- Ausencia total de botones de descarga y sin mensaje de alerta -->
            </div>
          </div>
        `;

        const fakePage = createFakePageFromDom(dom);
        const inspection = await selectAndInspectRcvTab(
          fakePage,
          'Compras',
          undefined,
          { year: 2026, month: 2 },
          { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
        );

        expect(inspection.hasNoMovements).toBe(false);
        expect(inspection.canDownload).toBe(false);
        expect(inspection.periodConfirmed).toBe(true);
        expect(inspection.activeTabConfirmed).toBe(true);
        expect(inspection.tabDiagnostic?.noMovementsPatternFound).toBe(false);

        // Fail-closed estricto: al no haber mensaje ni botón, el código debe ser RCV_DOWNLOAD_UNAVAILABLE y NUNCA empty
        const recordResult = inspection.hasNoMovements
          ? { status: 'empty' }
          : inspection.canDownload
          ? { status: 'downloaded' }
          : { status: 'error', code: 'RCV_DOWNLOAD_UNAVAILABLE' };
        expect(recordResult.status).toBe('error');
        expect(recordResult.code).toBe('RCV_DOWNLOAD_UNAVAILABLE');
      });

      it('soporta variantes con/sin tildes, mayúsculas y patrón genérico "no hay información de"', async () => {
        const domAccents = new JSDOM(buildInitialRcvDom());
        domAccents.window.location.hash = '#venta/';
        domAccents.window.document.getElementById('results-area')!.innerHTML = `
          <div class="tab-content">
            <ul class="nav nav-tabs"><li class="active"><a href="#venta/">VENTA</a></li></ul>
            <div class="tab-pane active"><div>NO HAY INFORMACIÓN DE COMPRAS</div></div>
          </div>
        `;
        const pageAccents = createFakePageFromDom(domAccents);
        const inspAccents = await selectAndInspectRcvTab(
          pageAccents,
          'Ventas',
          undefined,
          { year: 2026, month: 2 },
          { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
        );
        expect(inspAccents.hasNoMovements).toBe(true);

        const domGeneric = new JSDOM(buildInitialRcvDom());
        domGeneric.window.location.hash = '#venta/';
        domGeneric.window.document.getElementById('results-area')!.innerHTML = `
          <div class="tab-content">
            <ul class="nav nav-tabs"><li class="active"><a href="#venta/">VENTA</a></li></ul>
            <div class="tab-pane active"><div>No hay información de documentos emitidos en el periodo</div></div>
          </div>
        `;
        const pageGeneric = createFakePageFromDom(domGeneric);
        const inspGeneric = await selectAndInspectRcvTab(
          pageGeneric,
          'Ventas',
          undefined,
          { year: 2026, month: 2 },
          { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
        );
        expect(inspGeneric.hasNoMovements).toBe(true);

        const domFallback = new JSDOM(buildInitialRcvDom());
        domFallback.window.location.hash = '#venta/';
        domFallback.window.document.getElementById('results-area')!.innerHTML = `
          <div class="tab-content">
            <ul class="nav nav-tabs"><li class="active"><a href="#venta/">VENTA</a></li></ul>
            <div class="tab-pane active"><div>No hay información disponible para este contribuyente</div></div>
          </div>
        `;
        const pageFallback = createFakePageFromDom(domFallback);
        const inspFallback = await selectAndInspectRcvTab(
          pageFallback,
          'Ventas',
          undefined,
          { year: 2026, month: 2 },
          { reconsultPeriod: false, timeoutMs: 300, pollIntervalMs: 30 }
        );
        expect(inspFallback.hasNoMovements).toBe(true);
      });
    });
  });
});

describe('selectRcvPeriod and period verification with realistic flat options, prefixes and angular states', () => {
  const buildFlatOptionsRcvDom = () => {
    return `
      <!DOCTYPE html>
      <html>
        <head><title>RCV Portal - Opciones Planas</title></head>
        <body>
          <main id="consdcv">
            <form name="formConsulta" id="formConsulta">
              <select name="rut" ng-model="rut">
                <option value="">Seleccione...</option>
                <option value="12345678-5">12.345.678-5</option>
              </select>
              <!-- Evidencia real autenticada: select #periodoMes ng-model periodoMes ng-options NULL opciones value planos ''/'01'/'02'/'03' texto Mes/Enero/Febrero/Marzo -->
              <select id="periodoMes" name="" ng-model="periodoMes">
                <option value="">Mes</option>
                <option value="01">Enero</option>
                <option value="02">Febrero</option>
                <option value="03">Marzo</option>
              </select>
              <!-- select ng-model periodoAnho ng-options NULL opciones value planos ''/'2017'/'2018'/'2019' (hasta 2026+) -->
              <select id="" name="" ng-model="periodoAnho">
                <option value="">Año</option>
                <option value="2024">2024</option>
                <option value="2025">2025</option>
                <option value="2026">2026</option>
              </select>
              <button type="submit" class="btn btn-default btn-xs-block btn-block">Consultar</button>
            </form>
          </main>
        </body>
      </html>
    `;
  };

  const buildPrefixOptionsRcvDom = () => {
    return `
      <!DOCTYPE html>
      <html>
        <head><title>RCV Portal - Prefijos Angular</title></head>
        <body>
          <main id="consdcv">
            <form name="formConsulta">
              <select id="periodoMes" ng-model="periodoMes">
                <option value="?">Mes</option>
                <option value="string:01">Enero</option>
                <option value="string:02">Febrero</option>
                <option value="string:03">Marzo</option>
              </select>
              <select ng-model="periodoAnho">
                <option value="?">Año</option>
                <option value="number:2025">2025</option>
                <option value="number:2026">2026</option>
              </select>
            </form>
          </main>
        </body>
      </html>
    `;
  };

  const createPageFromDom = (dom: JSDOM): SiiPageLike => {
    return {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (args: unknown) => unknown, arg: unknown) => {
        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        try {
          (globalThis as unknown as { document: Document }).document = dom.window.document;
          (globalThis as unknown as { window: unknown }).window = dom.window;
          return fn(arg);
        } finally {
          (globalThis as unknown as { document: Document }).document = origDoc;
          (globalThis as unknown as { window: unknown }).window = origWin;
        }
      }),
      locator: vi.fn().mockImplementation((_sel: string) => {
        return {
          nth: vi.fn().mockReturnValue({ selectOption: vi.fn().mockResolvedValue(undefined) }),
          first: vi.fn().mockReturnValue({ click: vi.fn().mockResolvedValue(undefined) }),
        };
      }),
    };
  };

  it('soporta opciones con value planos exactos ("02", "2026"), setea value, selectedIndex y eventos bubbles', async () => {
    const dom = new JSDOM(buildFlatOptionsRcvDom());
    const mesSelect = dom.window.document.getElementById('periodoMes') as HTMLSelectElement;
    const anhoSelect = dom.window.document.querySelector('select[ng-model="periodoAnho"]') as HTMLSelectElement;

    let mesInputFired = false;
    let mesChangeFired = false;
    let anhoInputFired = false;
    let anhoChangeFired = false;

    mesSelect.addEventListener('input', (e) => {
      if (e.bubbles) mesInputFired = true;
    });
    mesSelect.addEventListener('change', (e) => {
      if (e.bubbles) mesChangeFired = true;
    });
    anhoSelect.addEventListener('input', (e) => {
      if (e.bubbles) anhoInputFired = true;
    });
    anhoSelect.addEventListener('change', (e) => {
      if (e.bubbles) anhoChangeFired = true;
    });

    const page = createPageFromDom(dom);
    await selectRcvPeriod(page, { year: 2026, month: 2 });

    expect(mesSelect.value).toBe('02');
    expect(mesSelect.selectedIndex).toBe(2);
    expect(anhoSelect.value).toBe('2026');
    expect(anhoSelect.selectedIndex).toBe(3);

    expect(mesInputFired).toBe(true);
    expect(mesChangeFired).toBe(true);
    expect(anhoInputFired).toBe(true);
    expect(anhoChangeFired).toBe(true);

    const verified = await verifyPeriodSelected(page, { year: 2026, month: 2 });
    expect(verified).toBe(true);
  });

  it('soporta opciones con prefijos Angular ("string:02", "number:2026")', async () => {
    const dom = new JSDOM(buildPrefixOptionsRcvDom());
    const mesSelect = dom.window.document.getElementById('periodoMes') as HTMLSelectElement;
    const anhoSelect = dom.window.document.querySelector('select[ng-model="periodoAnho"]') as HTMLSelectElement;

    const page = createPageFromDom(dom);
    await selectRcvPeriod(page, { year: 2026, month: 2 });

    expect(mesSelect.value).toBe('string:02');
    expect(mesSelect.selectedIndex).toBe(2);
    expect(anhoSelect.value).toBe('number:2026');
    expect(anhoSelect.selectedIndex).toBe(2);

    const verified = await verifyPeriodSelected(page, { year: 2026, month: 2 });
    expect(verified).toBe(true);
  });

  it('caso sin angular global: no lanza EVALUATE_FAILED ni error por ausencia de API angular', async () => {
    const dom = new JSDOM(buildFlatOptionsRcvDom());
    // Garantizar ausencia total de angular en window
    (dom.window as unknown as { angular?: unknown }).angular = undefined;

    const page = createPageFromDom(dom);
    // selectRcvPeriod sin requireAngular debe completarse con éxito
    await expect(selectRcvPeriod(page, { year: 2026, month: 2 })).resolves.toBeUndefined();

    const mesSelect = dom.window.document.getElementById('periodoMes') as HTMLSelectElement;
    const anhoSelect = dom.window.document.querySelector('select[ng-model="periodoAnho"]') as HTMLSelectElement;
    expect(mesSelect.value).toBe('02');
    expect(anhoSelect.value).toBe('2026');

    const verified = await verifyPeriodSelected(page, { year: 2026, month: 2 });
    expect(verified).toBe(true);
  });

  it('con angular.element presente pero sin controller/scope: usa triggerHandler sin romper', async () => {
    const dom = new JSDOM(buildFlatOptionsRcvDom());
    const triggerHandlerSpy = vi.fn();

    (dom.window as unknown as { angular: unknown }).angular = {
      element: (_el: unknown) => ({
        triggerHandler: triggerHandlerSpy,
        controller: () => {
          throw new Error('ng-model controller not compiled yet');
        },
        scope: () => undefined,
      }),
    };

    const page = createPageFromDom(dom);
    await expect(selectRcvPeriod(page, { year: 2026, month: 2 })).resolves.toBeUndefined();
    expect(triggerHandlerSpy).toHaveBeenCalledWith('change');

    const verified = await verifyPeriodSelected(page, { year: 2026, month: 2 });
    expect(verified).toBe(true);
  });

  it('fallback por texto si options no tienen value exacto pero coinciden en text ("Febrero", "2026")', async () => {
    const dom = new JSDOM(`
      <!DOCTYPE html>
      <html><body>
        <select id="periodoMes">
          <option value="opt-mes">Mes</option>
          <option value="opt-1">Enero</option>
          <option value="opt-2">Febrero</option>
        </select>
        <select id="periodoAnho">
          <option value="opt-yr">Año</option>
          <option value="opt-y1">2025</option>
          <option value="opt-y2">2026</option>
        </select>
      </body></html>
    `);

    const page = createPageFromDom(dom);
    await selectRcvPeriod(page, { year: 2026, month: 2 });

    const mesSelect = dom.window.document.getElementById('periodoMes') as HTMLSelectElement;
    const anhoSelect = dom.window.document.getElementById('periodoAnho') as HTMLSelectElement;
    expect(mesSelect.value).toBe('opt-2');
    expect(anhoSelect.value).toBe('opt-y2');

    const verified = await verifyPeriodSelected(page, { year: 2026, month: 2 });
    expect(verified).toBe(true);
  });

  it('verificación estricta y fail-closed: falla si el período objetivo no existe en las opciones', async () => {
    const dom = new JSDOM(buildFlatOptionsRcvDom());
    const page = createPageFromDom(dom);

    // Año 2099 no existe en el DOM fixture
    let caughtErr: unknown;
    try {
      await selectRcvPeriod(page, { year: 2099, month: 2 });
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(AppError);
    expect((caughtErr as AppError).code).toBe('PERIOD_SELECT_FAILED');
    expect((caughtErr as AppError).stage).toBe('period_selection');

    // verifyPeriodSelected debe retornar false (fail-closed)
    const verified = await verifyPeriodSelected(page, { year: 2099, month: 2 });
    expect(verified).toBe(false);
  });
});

describe('handleNavigationError', () => {
  it('re-lanza AppError intacto preservando código, status y stage', () => {
    const original = new AppError('CUSTOM_CODE', 'Mensaje original', 400, undefined, { stage: 'custom_stage' });
    try {
      handleNavigationError(original, 'fallback_stage');
    } catch (err) {
      expect(err).toBe(original);
      expect((err as AppError).code).toBe('CUSTOM_CODE');
      expect((err as AppError).stage).toBe('custom_stage');
    }
  });

  it('preserva duck-typed AppError con propiedad code legítima', () => {
    const duckError = { code: 'PERIOD_SELECT_FAILED', message: 'Fallo específico', httpStatus: 502, stage: 'period_selection' };
    try {
      handleNavigationError(duckError, 'period_selection');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('PERIOD_SELECT_FAILED');
      expect((err as AppError).stage).toBe('period_selection');
    }
  });

  it('clasifica AbortError en OPERATION_ABORTED con HTTP 499', () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    try {
      handleNavigationError(abortErr, 'period_selection');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('OPERATION_ABORTED');
      expect((err as AppError).httpStatus).toBe(499);
      expect((err as AppError).stage).toBe('period_selection');
    }
  });

  it('clasifica TimeoutError en TIMEOUT con HTTP 504', () => {
    const timeoutErr = new Error('page.waitForSelector: Timeout 15000ms exceeded.');
    timeoutErr.name = 'TimeoutError';
    try {
      handleNavigationError(timeoutErr, 'query_button');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('TIMEOUT');
      expect((err as AppError).httpStatus).toBe(504);
      expect((err as AppError).stage).toBe('query_button');
    }
  });

  it('preserva códigos legítimos mencionados en el mensaje de error', () => {
    const msgErr = new Error('Error en el proceso: PERIOD_SELECT_FAILED');
    try {
      handleNavigationError(msgErr, 'period_selection');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('PERIOD_SELECT_FAILED');
      expect((err as AppError).stage).toBe('period_selection');
    }
  });

  it('clasifica error desconocido en EVALUATE_FAILED con el stage provisto', () => {
    const genericErr = new TypeError('Cannot read properties of undefined');
    try {
      handleNavigationError(genericErr, 'period_selection');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('EVALUATE_FAILED');
      expect((err as AppError).stage).toBe('period_selection');
    }
  });
});

describe('Anti-regresión: funciones evaluadas en navegador (page.evaluate) son JS puro serializable', () => {
  const rcvNavFilePath = fileURLToPath(new URL('../src/infrastructure/sii/rcvNavigation.ts', import.meta.url));
  const sourceText = fs.readFileSync(rcvNavFilePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    'rcvNavigation.ts',
    sourceText,
    ts.ScriptTarget.Latest,
    true
  );

  // 1. Extraer dinámicamente de la AST todas las funciones pasadas a page.evaluate(...)
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

  it('detecta todas las funciones evaluadas requeridas en rcvNavigation.ts', () => {
    const expectedEvaluated = [
      'queryContributorDom',
      'queryRcvResultsStatus',
      'evaluateSelectPeriodMetadata',
      'evaluateSyncAngularPeriod',
      'evaluateHasConsultarButton',
      'evaluateClickConsultarFallback',
      'evaluateClickConsultar',
      'evaluateSwitchRcvTab',
      'evaluateInspectRcvActiveTab',
      'evaluateClickDownloadCsv',
      'evaluateHandleDownloadModal',
      'evaluateCollectDataUriAnchors',
      'evaluateExtractNewDataUri',
    ];
    for (const fn of expectedEvaluated) {
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

  it('cada función evaluada está exportada para pruebas y desacoplamiento', () => {
    for (const fnName of evaluatedFnNames) {
      const decl = getFunctionDeclaration(fnName);
      expect(decl, `Función ${fnName} debe existir en rcvNavigation.ts`).not.toBeNull();
      const hasExport = decl?.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      expect(hasExport, `Función ${fnName} debe estar exportada`).toBe(true);
    }
  });

  it('el cuerpo crudo de cada función evaluada en rcvNavigation.ts no contiene anotaciones TS y pasa new Function sin lanzar', () => {
    for (const fnName of evaluatedFnNames) {
      const decl = getFunctionDeclaration(fnName);
      expect(decl?.body, `Función ${fnName} debe tener cuerpo`).toBeDefined();
      const statementsText = decl!.body!.statements.map((s) => s.getText(sourceFile)).join('\n');

      expect(() => {
        try {
          new Function(statementsText);
        } catch (err: unknown) {
          throw new Error(
            `Función evaluada "${fnName}" falló en new Function() con cuerpo crudo del archivo .ts:\n` +
            `${(err as Error).message}\n` +
            `Cuerpo:\n${statementsText.slice(0, 300)}...`
          );
        }
      }).not.toThrow();
    }
  });

  it('cada función evaluada exportada en runtime pasa new Function(fn.toString()) sin lanzar', () => {
    const runtimeFns: Record<string, unknown> = {
      queryContributorDom,
      queryRcvResultsStatus,
      evaluateSelectPeriodMetadata,
      evaluateSyncAngularPeriod,
      evaluateHasConsultarButton,
      evaluateClickConsultarFallback,
      evaluateClickConsultar,
      evaluateSwitchRcvTab,
      evaluateSwitchComprasRegistroSubtab,
      evaluateInspectRcvActiveTab,
      evaluateClickDownloadCsv,
      evaluateHandleDownloadModal,
      evaluateCollectDataUriAnchors,
      evaluateExtractNewDataUri,
    };

    for (const fnName of evaluatedFnNames) {
      const fn = runtimeFns[fnName];
      expect(typeof fn, `Función ${fnName} debe existir en el runtime`).toBe('function');
      const fnStr = (fn as () => unknown).toString();
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

  it('ninguna función evaluada contiene identificadores prohibidos de bundler/node (__name, __publicField, __defProp, require, exports, module)', () => {
    const runtimeFns: Record<string, unknown> = {
      queryContributorDom,
      queryRcvResultsStatus,
      evaluateSelectPeriodMetadata,
      evaluateSyncAngularPeriod,
      evaluateHasConsultarButton,
      evaluateClickConsultarFallback,
      evaluateClickConsultar,
      evaluateSwitchRcvTab,
      evaluateSwitchComprasRegistroSubtab,
      evaluateInspectRcvActiveTab,
      evaluateClickDownloadCsv,
      evaluateHandleDownloadModal,
      evaluateCollectDataUriAnchors,
      evaluateExtractNewDataUri,
    };

    for (const fnName of evaluatedFnNames) {
      const fn = runtimeFns[fnName];
      expect(typeof fn, `Función ${fnName} debe existir en el runtime`).toBe('function');
      const fnStr = (fn as () => unknown).toString();

      for (const banned of BANNED_BROWSER_IDENTIFIERS) {
        const regex = new RegExp(`\\b${banned}\\b`);
        expect(
          regex.test(fnStr),
          `Función evaluada "${fnName}" no debe contener "${banned}" en su serialización toString():\n${fnStr.slice(0, 300)}`
        ).toBe(false);
      }
    }
  });

  it('cada función evaluada se ejecuta exitosamente en un sandbox VM aislado sin identificadores externos inyectados', () => {
    const runtimeFns: Record<string, unknown> = {
      queryContributorDom,
      queryRcvResultsStatus,
      evaluateSelectPeriodMetadata,
      evaluateSyncAngularPeriod,
      evaluateHasConsultarButton,
      evaluateClickConsultarFallback,
      evaluateClickConsultar,
      evaluateSwitchRcvTab,
      evaluateSwitchComprasRegistroSubtab,
      evaluateInspectRcvActiveTab,
      evaluateClickDownloadCsv,
      evaluateHandleDownloadModal,
      evaluateCollectDataUriAnchors,
      evaluateExtractNewDataUri,
    };

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

    const dummyArgs: Record<string, unknown> = {
      evaluateSwitchRcvTab: 'compras',
      evaluateSwitchComprasRegistroSubtab: undefined,
      evaluateInspectRcvActiveTab: {
        targetTab: 'compras',
        expectedPeriod: { year: 2026, month: 2 },
      },
      evaluateSelectPeriodMetadata: {
        targetYear: '2026',
        targetMonth: '02',
        targetMonthNum: '2',
        targetMonthName: 'febrero',
      },
      evaluateSyncAngularPeriod: {
        yearIdx: 0,
        monthIdx: 1,
        yVal: '2026',
        mVal: '02',
        targetYear: '2026',
        targetMonth: '02',
        targetMonthNum: '2',
        targetMonthName: 'febrero',
      },
      queryRcvResultsStatus: { year: 2026, month: 2 },
      evaluateCollectDataUriAnchors: undefined,
      evaluateExtractNewDataUri: {
        priorHrefs: [],
        maxBytes: 10485760,
      },
    };

    for (const fnName of evaluatedFnNames) {
      const fn = runtimeFns[fnName];
      const fnStr = (fn as () => unknown).toString();

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

      const arg = dummyArgs[fnName];
      expect(() => {
        compiled(arg);
      }, `Función ${fnName} ejecutada en sandbox VM`).not.toThrow();
    }
  });

  it('prueba de control anti-falsos positivos: verifica que anotaciones TS en el cuerpo sí hacen fallar new Function', () => {
    const snippetWithType = `
      function isForbidden(el: MinimalDomElement): boolean {
        return false;
      }
      let matched: MinimalDomElement | null = null;
    `;
    expect(() => {
      new Function(snippetWithType);
    }).toThrow(SyntaxError);
  });

  it('control negativo: verifica que identificadores prohibidos como __name son detectados y fallan la ejecución en sandbox VM', () => {
    const faultyFunctionSrc = `function faultyEvaluation() {
      function internalHelper() { return true; }
      __name(internalHelper, "internalHelper");
      return internalHelper();
    }`;

    // 1. Falla la lista negra
    const detectedBanned = BANNED_BROWSER_IDENTIFIERS.filter((b) =>
      new RegExp(`\\b${b}\\b`).test(faultyFunctionSrc)
    );
    expect(detectedBanned).toEqual(['__name']);

    // 2. Falla la ejecución en sandbox VM con ReferenceError
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


