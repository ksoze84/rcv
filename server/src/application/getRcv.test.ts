import { describe, it, expect, vi } from 'vitest';
import { executeGetRcv } from './getRcv.js';
import { RcvProvider, RcvDownloads } from '../domain/rcvProvider.js';
import { AppError } from '../domain/errors.js';
import { Credentials } from '../../../shared/rcv.js';

describe('executeGetRcv', () => {
  const dummyCreds: Credentials = {
    rut: '11111111-1',
    password: 'dummy-password',
    authMode: 'tributaria',
  };

  it('procesa correctamente cuando ambas descargas contienen CSV válidos', async () => {
    const comprasCsv = new TextEncoder().encode('RUT;Monto\n76123456-7;10000');
    const ventasCsv = new TextEncoder().encode('Folio;Total\n001;5000');

    const mockProvider: RcvProvider = {
      fetch: vi.fn().mockResolvedValue({
        compras: { status: 'downloaded', bytes: comprasCsv },
        ventas: { status: 'downloaded', bytes: ventasCsv },
      } as RcvDownloads),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeGetRcv(
      mockProvider,
      dummyCreds,
      new AbortController().signal
    );

    expect(result.status).toBe('complete');
    expect(result.period).toEqual({ year: 2026, month: 2 });
    expect(result.compras.status).toBe('ok');
    if (result.compras.status === 'ok') {
      expect(result.compras.columns).toEqual(['RUT', 'Monto']);
      expect(result.compras.rows).toEqual([['76123456-7', '10000']]);
    }
    expect(result.ventas.status).toBe('ok');
    if (result.ventas.status === 'ok') {
      expect(result.ventas.columns).toEqual(['Folio', 'Total']);
      expect(result.ventas.rows).toEqual([['001', '5000']]);
    }
  });

  it('soporta status empty legítimo del provider y retorna complete', async () => {
    const comprasCsv = new TextEncoder().encode('RUT;Monto\n76123456-7;10000');

    const mockProvider: RcvProvider = {
      fetch: vi.fn().mockResolvedValue({
        compras: { status: 'downloaded', bytes: comprasCsv },
        ventas: { status: 'empty' },
      } as RcvDownloads),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeGetRcv(
      mockProvider,
      dummyCreds,
      new AbortController().signal
    );

    expect(result.status).toBe('complete');
    expect(result.compras.status).toBe('ok');
    expect(result.ventas.status).toBe('empty');
    if (result.compras.status === 'ok') {
      expect(result.compras.rows).toHaveLength(1);
    }
  });

  it('retorna complete cuando ambos registros (compras y ventas) están vacíos (status empty)', async () => {
    const mockProvider: RcvProvider = {
      fetch: vi.fn().mockResolvedValue({
        compras: { status: 'empty' },
        ventas: { status: 'empty' },
      } as RcvDownloads),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeGetRcv(
      mockProvider,
      dummyCreds,
      new AbortController().signal
    );

    expect(result.status).toBe('complete');
    expect(result.compras.status).toBe('empty');
    expect(result.ventas.status).toBe('empty');
  });

  it('retorna complete cuando compras está vacío y ventas tiene registros (conserva ventas)', async () => {
    const ventasCsv = new TextEncoder().encode('Folio;Total\n001;5000');

    const mockProvider: RcvProvider = {
      fetch: vi.fn().mockResolvedValue({
        compras: { status: 'empty' },
        ventas: { status: 'downloaded', bytes: ventasCsv },
      } as RcvDownloads),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeGetRcv(
      mockProvider,
      dummyCreds,
      new AbortController().signal
    );

    expect(result.status).toBe('complete');
    expect(result.compras.status).toBe('empty');
    expect(result.ventas.status).toBe('ok');
    if (result.ventas.status === 'ok') {
      expect(result.ventas.rows).toHaveLength(1);
    }
  });

  it('procesa CSV válido con sólo encabezados (cero filas de datos) como status empty y retorna complete', async () => {
    const comprasCsv = new TextEncoder().encode('RUT Emisor;Folio;Monto\n76123456-7;101;25000');
    // Ventas descargó un CSV válido pero sin movimientos (solo encabezados)
    const ventasHeadersOnly = new TextEncoder().encode('Folio;RUT Receptor;Total\n');

    const mockProvider: RcvProvider = {
      fetch: vi.fn().mockResolvedValue({
        compras: { status: 'downloaded', bytes: comprasCsv },
        ventas: { status: 'downloaded', bytes: ventasHeadersOnly },
      } as RcvDownloads),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeGetRcv(
      mockProvider,
      dummyCreds,
      new AbortController().signal
    );

    expect(result.status).toBe('complete');
    expect(result.compras.status).toBe('ok');
    expect(result.ventas.status).toBe('empty');
    if (result.ventas.status === 'empty') {
      expect(result.ventas.rows).toEqual([]);
      expect(result.ventas.columns).toEqual(['Folio', 'RUT Receptor', 'Total']);
    }
  });

  it('un error técnico en ventas NO se convierte en empty y resulta en status partial', async () => {
    const comprasCsv = new TextEncoder().encode('RUT;Monto\n76123456-7;10000');

    const mockProvider: RcvProvider = {
      fetch: vi.fn().mockResolvedValue({
        compras: { status: 'downloaded', bytes: comprasCsv },
        ventas: {
          status: 'error',
          error: {
            code: 'RCV_DOWNLOAD_UNAVAILABLE',
            message: 'No se encuentra disponible la opción de descarga de detalles en la pestaña de Ventas.',
          },
        },
      } as RcvDownloads),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeGetRcv(
      mockProvider,
      dummyCreds,
      new AbortController().signal
    );

    expect(result.status).toBe('partial');
    expect(result.compras.status).toBe('ok');
    expect(result.ventas.status).toBe('error');
    if (result.ventas.status === 'error') {
      expect(result.ventas.error.code).toBe('RCV_DOWNLOAD_UNAVAILABLE');
    }
  });

  it('cuando compras está empty y ventas falla con error técnico, genera partial sin ocultar el error', async () => {
    const mockProvider: RcvProvider = {
      fetch: vi.fn().mockResolvedValue({
        compras: { status: 'empty' },
        ventas: {
          status: 'error',
          error: { code: 'NETWORK_ERROR', message: 'Fallo de red en ventas' },
        },
      } as RcvDownloads),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeGetRcv(
      mockProvider,
      dummyCreds,
      new AbortController().signal
    );

    expect(result.status).toBe('partial');
    expect(result.compras.status).toBe('empty');
    expect(result.ventas.status).toBe('error');
    if (result.ventas.status === 'error') {
      expect(result.ventas.error.code).toBe('NETWORK_ERROR');
    }
  });

  it('genera resultado partial si uno tiene éxito y el otro falla con error', async () => {
    const comprasCsv = new TextEncoder().encode('RUT;Monto\n76123456-7;10000');

    const mockProvider: RcvProvider = {
      fetch: vi.fn().mockResolvedValue({
        compras: { status: 'downloaded', bytes: comprasCsv },
        ventas: {
          status: 'error',
          error: { code: 'SII_TIMEOUT', message: 'Tiempo agotado al descargar ventas' },
        },
      } as RcvDownloads),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeGetRcv(
      mockProvider,
      dummyCreds,
      new AbortController().signal
    );

    expect(result.status).toBe('partial');
    expect(result.compras.status).toBe('ok');
    expect(result.ventas.status).toBe('error');
    if (result.ventas.status === 'error') {
      expect(result.ventas.error.code).toBe('SII_TIMEOUT');
    }
  });

  it('mapea errores de parseo de CSV corrupto a status error en el registro parcial', async () => {
    const invalidCsvBytes = new TextEncoder().encode('<!doctype html><html><body>Error de sesión</body></html>');

    const mockProvider: RcvProvider = {
      fetch: vi.fn().mockResolvedValue({
        compras: { status: 'downloaded', bytes: invalidCsvBytes },
        ventas: { status: 'empty' },
      } as RcvDownloads),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeGetRcv(
      mockProvider,
      dummyCreds,
      new AbortController().signal
    );

    expect(result.status).toBe('partial');
    expect(result.compras.status).toBe('error');
    if (result.compras.status === 'error') {
      expect(result.compras.error.code).toBe('CSV_HTML_RECEIVED');
      expect(result.compras.error.message).toContain('Error al procesar el archivo CSV de Compras');
    }
    expect(result.ventas.status).toBe('empty');
  });

  it('lanza AppError 502 con detalles tipados y sin filtrar mensajes arbitrarios si ambas descargas fallan', async () => {
    const mockProvider: RcvProvider = {
      fetch: vi.fn().mockResolvedValue({
        compras: {
          status: 'error',
          error: { code: 'FAIL_1', message: 'Fallo compras con info interna' },
        },
        ventas: {
          status: 'error',
          error: { code: 'FAIL_2', message: 'Fallo ventas con info interna' },
        },
      } as RcvDownloads),
      close: vi.fn().mockResolvedValue(undefined),
    };

    let capturedDiag: unknown;
    let thrownError: unknown;
    try {
      await executeGetRcv(
        mockProvider,
        dummyCreds,
        new AbortController().signal,
        {
          onDiagnostic: (diag) => {
            capturedDiag = diag;
          },
        }
      );
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(AppError);
    const appErr = thrownError as AppError;
    expect(appErr.httpStatus).toBe(502);
    expect(appErr.code).toBe('RCV_FETCH_FAILED');
    expect(appErr.message).toBe('No fue posible obtener los registros de Compras ni Ventas.');
    expect(appErr.message).not.toContain('Fallo compras con info interna');
    expect(appErr.message).not.toContain('Fallo ventas con info interna');
    expect(appErr.details).toEqual({
      comprasCode: 'FAIL_1',
      ventasCode: 'FAIL_2',
    });
    expect(capturedDiag).toEqual({
      compras: { status: 'error', count: null, error: 'FAIL_1' },
      ventas: { status: 'error', count: null, error: 'FAIL_2' },
    });
  });

  it('propaga inmediatamente si provider.fetch lanza una excepción de identidad o error crítico', async () => {
    const mockProvider: RcvProvider = {
      fetch: vi.fn().mockRejectedValue(new AppError('IDENTITY_MISMATCH', 'RUT no coincide', 403)),
      close: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      executeGetRcv(mockProvider, dummyCreds, new AbortController().signal)
    ).rejects.toThrow(
      expect.objectContaining({
        httpStatus: 403,
        code: 'IDENTITY_MISMATCH',
      })
    );
  });
});
