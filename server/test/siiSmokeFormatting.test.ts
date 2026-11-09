import { describe, it, expect } from 'vitest';
import { buildSmokeFailedResult } from '../../tests/browser/sii-controlled-smoke.js';
import { AppError } from '../src/domain/errors.js';

describe('sii-controlled-smoke buildSmokeFailedResult', () => {

  it('en modo --full preserva códigos individuales de compras y ventas desde aggregateDiagnostic y no incluye flags auth false engañosos', () => {
    const result = buildSmokeFailedResult({
      isFull: true,
      mode: 'tributaria',
      currentPhase: 'init',
      safeCode: 'RCV_FETCH_FAILED',
      aggregateDiagnostic: {
        compras: { status: 'error', count: null, error: 'CAPTURE_FAILED' },
        ventas: { status: 'error', count: null, error: 'RCV_DOWNLOAD_UNAVAILABLE' },
      },
      formularioOk: false,
      formOrigin: null,
      retornoOk: false,
      postReturnOrigin: null,
      identidadOk: false,
      authenticationWasReserved: true,
      blocked: false,
      elapsedMs: 32357,
    });

    expect(result.status).toBe('FAILED');
    expect(result.code).toBe('RCV_FETCH_FAILED');
    expect(result.period).toBe('2026-02');
    expect(result.compras).toEqual({
      status: 'error',
      count: null,
      error: 'CAPTURE_FAILED',
    });
    expect(result.ventas).toEqual({
      status: 'error',
      count: null,
      error: 'RCV_DOWNLOAD_UNAVAILABLE',
    });

    // Validar ausencia estricta de flags de auth engañosos en resumen full
    expect(result.formularioOk).toBeUndefined();
    expect(result.formOrigin).toBeUndefined();
    expect(result.retornoOk).toBeUndefined();
    expect(result.postReturnOrigin).toBeUndefined();
    expect(result.identidadOk).toBeUndefined();
  });

  it('en modo --full extrae códigos individuales desde AppError.details si no hay callback previo', () => {
    const appErrorWithDetails = new AppError(
      'RCV_FETCH_FAILED',
      'No fue posible obtener los registros de Compras ni Ventas.',
      502,
      undefined,
      {
        comprasCode: 'DOWNLOAD_TIMEOUT',
        ventasCode: 'SII_SESSION_EXPIRED',
      }
    );

    const result = buildSmokeFailedResult({
      isFull: true,
      mode: 'tributaria',
      currentPhase: 'init',
      safeCode: 'RCV_FETCH_FAILED',
      error: appErrorWithDetails,
      formularioOk: false,
      formOrigin: null,
      retornoOk: false,
      postReturnOrigin: null,
      identidadOk: false,
      authenticationWasReserved: true,
      blocked: false,
      elapsedMs: 25000,
    });

    expect(result.compras).toEqual({
      status: 'error',
      count: null,
      error: 'DOWNLOAD_TIMEOUT',
    });
    expect(result.ventas).toEqual({
      status: 'error',
      count: null,
      error: 'SII_SESSION_EXPIRED',
    });
    expect(result.formularioOk).toBeUndefined();
    expect(result.identidadOk).toBeUndefined();
  });

  it('en modo --full preserva stage en compras y ventas desde aggregateDiagnostic', () => {
    const result = buildSmokeFailedResult({
      isFull: true,
      mode: 'clave-unica',
      currentPhase: 'init',
      safeCode: 'RCV_FETCH_FAILED',
      aggregateDiagnostic: {
        compras: { status: 'error', count: null, error: 'PERIOD_SELECT_FAILED', stage: 'period_selection' },
        ventas: { status: 'error', count: null, error: 'QUERY_BUTTON_MISSING', stage: 'query_button' },
      },
      formularioOk: false,
      formOrigin: null,
      retornoOk: false,
      postReturnOrigin: null,
      identidadOk: false,
      authenticationWasReserved: true,
      blocked: false,
      elapsedMs: 9849,
    });

    expect(result.status).toBe('FAILED');
    expect(result.code).toBe('RCV_FETCH_FAILED');
    expect(result.compras).toEqual({
      status: 'error',
      count: null,
      error: 'PERIOD_SELECT_FAILED',
      stage: 'period_selection',
    });
    expect(result.ventas).toEqual({
      status: 'error',
      count: null,
      error: 'QUERY_BUTTON_MISSING',
      stage: 'query_button',
    });
  });

  it('en modo --full extrae comprasStage y ventasStage desde AppError.details si no hay callback previo', () => {
    const appErrorWithDetails = new AppError(
      'RCV_FETCH_FAILED',
      'No fue posible obtener los registros de Compras ni Ventas.',
      502,
      undefined,
      {
        comprasCode: 'RESULTS_NOT_RENDERED',
        ventasCode: 'TAB_NOT_FOUND',
        comprasStage: 'results_render',
        ventasStage: 'tab_selection',
      }
    );

    const result = buildSmokeFailedResult({
      isFull: true,
      mode: 'clave-unica',
      currentPhase: 'init',
      safeCode: 'RCV_FETCH_FAILED',
      error: appErrorWithDetails,
      formularioOk: false,
      formOrigin: null,
      retornoOk: false,
      postReturnOrigin: null,
      identidadOk: false,
      authenticationWasReserved: true,
      blocked: false,
      elapsedMs: 12000,
    });

    expect(result.compras).toEqual({
      status: 'error',
      count: null,
      error: 'RESULTS_NOT_RENDERED',
      stage: 'results_render',
    });
    expect(result.ventas).toEqual({
      status: 'error',
      count: null,
      error: 'TAB_NOT_FOUND',
      stage: 'tab_selection',
    });
    expect(result.formularioOk).toBeUndefined();
    expect(result.identidadOk).toBeUndefined();
  });

  it('en modo --full propaga códigos de diagnóstico CSV (ej. CSV_HTML_RECEIVED, CSV_ZIP_RECEIVED) sin filtrar contenido ni datos tributarios', () => {
    const appErrorWithCsvDetails = new AppError(
      'RCV_FETCH_FAILED',
      'No fue posible obtener los registros de Compras ni Ventas.',
      502,
      undefined,
      {
        comprasCode: 'RCV_DOWNLOAD_UNAVAILABLE',
        ventasCode: 'CSV_HTML_RECEIVED',
        comprasStage: 'tab_inspection',
      }
    );

    const result = buildSmokeFailedResult({
      isFull: true,
      mode: 'clave-unica',
      currentPhase: 'init',
      safeCode: 'RCV_FETCH_FAILED',
      error: appErrorWithCsvDetails,
      authenticationWasReserved: true,
      blocked: false,
      elapsedMs: 14500,
    });

    expect(result.status).toBe('FAILED');
    expect(result.code).toBe('RCV_FETCH_FAILED');
    expect(result.compras).toEqual({
      status: 'error',
      count: null,
      error: 'RCV_DOWNLOAD_UNAVAILABLE',
      stage: 'tab_inspection',
    });
    expect(result.ventas).toEqual({
      status: 'error',
      count: null,
      error: 'CSV_HTML_RECEIVED',
    });
  });

  it('en modo --full preserva tabDiagnostic en compras y ventas desde aggregateDiagnostic', () => {
    const tabDiagnostic = {
      activeTabConfirmed: true,
      periodConfirmed: true,
      subtabRegistroFound: true,
      subtabRegistroActive: true,
      downloadButtonsFound: 1,
      detalleButtonFound: false,
      detalleButtonVisible: false,
      tableCount: 2,
      noMovementsPatternFound: false,
      consultarClicked: true,
      hashEndsWith: '#compraRegistro/',
      elapsedMsInTab: 15420,
    };

    const result = buildSmokeFailedResult({
      isFull: true,
      mode: 'clave-unica',
      currentPhase: 'completed',
      safeCode: 'RCV_FETCH_FAILED',
      aggregateDiagnostic: {
        compras: {
          status: 'error',
          count: null,
          error: 'RCV_DOWNLOAD_UNAVAILABLE',
          stage: 'tab_inspection',
          tabDiagnostic,
        },
        ventas: {
          status: 'ok',
          count: 1,
        },
      },
      formularioOk: false,
      formOrigin: null,
      retornoOk: false,
      postReturnOrigin: null,
      identidadOk: true,
      authenticationWasReserved: true,
      blocked: false,
      elapsedMs: 23456,
    });

    expect(result.compras).toEqual({
      status: 'error',
      count: null,
      error: 'RCV_DOWNLOAD_UNAVAILABLE',
      stage: 'tab_inspection',
      tabDiagnostic,
    });
    expect(result.ventas).toEqual({
      status: 'ok',
      count: 1,
    });
  });

  it('en modo --full extrae comprasTabDiagnostic y ventasTabDiagnostic desde AppError.details si no hay callback previo', () => {
    const comprasTabDiag = {
      activeTabConfirmed: true,
      periodConfirmed: true,
      subtabRegistroFound: false,
      subtabRegistroActive: false,
      downloadButtonsFound: 0,
      detalleButtonFound: false,
      detalleButtonVisible: false,
      tableCount: 0,
      noMovementsPatternFound: false,
      consultarClicked: true,
      hashEndsWith: '#compra/',
      elapsedMsInTab: 25000,
    };

    const appErrorWithTabDiag = new AppError(
      'RCV_FETCH_FAILED',
      'No fue posible obtener los registros de Compras ni Ventas.',
      502,
      undefined,
      {
        comprasCode: 'RCV_DOWNLOAD_UNAVAILABLE',
        ventasCode: 'RCV_DOWNLOAD_UNAVAILABLE',
        comprasStage: 'tab_inspection',
        ventasStage: 'tab_inspection',
        comprasTabDiagnostic: comprasTabDiag,
      }
    );

    const result = buildSmokeFailedResult({
      isFull: true,
      mode: 'clave-unica',
      currentPhase: 'init',
      safeCode: 'RCV_FETCH_FAILED',
      error: appErrorWithTabDiag,
      authenticationWasReserved: true,
      blocked: false,
      elapsedMs: 30000,
    });

    expect(result.compras?.tabDiagnostic).toEqual(comprasTabDiag);
    expect(result.ventas?.tabDiagnostic).toBeUndefined();
  });

  it('en modo auth-only incluye las banderas reales de formulario, retorno e identidad', () => {
    const result = buildSmokeFailedResult({
      isFull: false,
      mode: 'clave-unica',
      currentPhase: 'formulario',
      safeCode: 'SESSION_UNVERIFIED',
      formularioOk: true,
      formOrigin: 'https://accounts.claveunica.gob.cl',
      retornoOk: false,
      postReturnOrigin: null,
      identidadOk: false,
      retornoDiagnostico: {
        formularioSigue: true,
        origen: 'https://accounts.claveunica.gob.cl',
        ruta: '/accounts/login/',
        codigo: 'FORM_STILL_PRESENT',
      },
      authenticationWasReserved: true,
      blocked: false,
      elapsedMs: 45346,
    });

    expect(result.status).toBe('FAILED');
    expect(result.code).toBe('SESSION_UNVERIFIED');
    expect(result.period).toBeUndefined();
    expect(result.formularioOk).toBe(true);
    expect(result.formOrigin).toBe('https://accounts.claveunica.gob.cl');
    expect(result.retornoOk).toBe(false);
    expect(result.identidadOk).toBe(false);
    expect(result.retornoDiagnostico).toEqual({
      formularioSigue: true,
      origen: 'https://accounts.claveunica.gob.cl',
      ruta: '/accounts/login/',
      codigo: 'FORM_STILL_PRESENT',
    });
  });
});
