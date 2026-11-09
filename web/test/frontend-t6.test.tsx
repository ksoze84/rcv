// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { App } from '../src/App.js';
import { CredentialsForm } from '../src/components/CredentialsForm.js';
import { RcvTable } from '../src/components/RcvTable.js';
import * as apiModule from '../src/api/rcv.js';
import type { RcvResult } from '../../shared/rcv.js';

describe('Frontend T6 - Tests Unitarios y de Integración', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('CredentialsForm', () => {
    it('soporta los dos modos de autenticación (tributaria por defecto y clave-unica)', () => {
      const handleSubmit = vi.fn();
      render(<CredentialsForm onSubmit={handleSubmit} isLoading={false} />);

      const tributariaRadio = screen.getByRole('radio', { name: /clave tributaria/i }) as HTMLInputElement;
      const claveUnicaRadio = screen.getByRole('radio', { name: /clave única/i }) as HTMLInputElement;

      expect(tributariaRadio.checked).toBe(true);
      expect(claveUnicaRadio.checked).toBe(false);

      fireEvent.click(claveUnicaRadio);
      expect(claveUnicaRadio.checked).toBe(true);
      expect(tributariaRadio.checked).toBe(false);
    });

    it('valida RUT inválido y no realiza submit', () => {
      const handleSubmit = vi.fn();
      render(<CredentialsForm onSubmit={handleSubmit} isLoading={false} />);

      const rutInput = screen.getByLabelText(/^RUT/i);
      const passwordInput = screen.getByLabelText(/^Contraseña/i);
      const submitBtn = screen.getByRole('button', { name: /obtener registro/i });

      fireEvent.change(rutInput, { target: { value: '11.111.111-9' } }); // DV inválido
      fireEvent.change(passwordInput, { target: { value: 'secreto123' } });
      fireEvent.click(submitBtn);

      expect(handleSubmit).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(/dígito verificador es inválido/i);
    });

    it('vacía inmediatamente el campo de contraseña al enviar y preserva espacios intactos en el payload', () => {
      const handleSubmit = vi.fn();
      render(<CredentialsForm onSubmit={handleSubmit} isLoading={false} />);

      const rutInput = screen.getByLabelText(/^RUT/i) as HTMLInputElement;
      const passwordInput = screen.getByLabelText(/^Contraseña/i) as HTMLInputElement;
      const submitBtn = screen.getByRole('button', { name: /obtener registro/i });

      // RUT válido: 11111111-1 (11.111.111-1)
      fireEvent.change(rutInput, { target: { value: '11.111.111-1' } });
      const rawPasswordWithSpaces = '  pass con espacios  ';
      fireEvent.change(passwordInput, { target: { value: rawPasswordWithSpaces } });

      fireEvent.click(submitBtn);

      // Se llamó con la contraseña exacta sin trim y RUT normalizado
      expect(handleSubmit).toHaveBeenCalledTimes(1);
      expect(handleSubmit).toHaveBeenCalledWith({
        rut: '11111111-1',
        password: rawPasswordWithSpaces,
        authMode: 'tributaria',
      });

      // El campo de contraseña se vació de inmediato para seguridad
      expect(passwordInput.value).toBe('');
      // El RUT se mantiene visible
      expect(rutInput.value).toBe('11111111-1');
    });

    it('deshabilita los controles y el botón durante isLoading o isDisabled', () => {
      const handleSubmit = vi.fn();
      const { rerender } = render(
        <CredentialsForm onSubmit={handleSubmit} isLoading={true} />
      );

      const submitBtn = screen.getByRole('button');
      expect(submitBtn).toBeDisabled();
      expect(screen.getByLabelText(/^RUT/i)).toBeDisabled();
      expect(screen.getByLabelText(/^Contraseña/i)).toBeDisabled();

      rerender(<CredentialsForm onSubmit={handleSubmit} isLoading={false} isDisabled={true} />);
      expect(submitBtn).toBeDisabled();
    });
  });

  describe('RcvTable', () => {
    it('renderiza correctamente columnas con nombres duplicados sin fallar', () => {
      render(
        <RcvTable
          title="Registro de Compras"
          type="compras"
          record={{
            status: 'ok',
            columns: ['Folio', 'Monto', 'Monto'],
            rows: [['101', '500', '1000']],
          }}
        />
      );

      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Registro de Compras');
      const table = screen.getByRole('region', { name: /tabla de registro de compras/i });
      expect(table).toBeInTheDocument();
      const montos = screen.getAllByRole('columnheader', { name: 'Monto' });
      expect(montos).toHaveLength(2);
    });

    it('escapa contenido potencialmente malicioso evitando inyección XSS', () => {
      const maliciousScript = '<script>alert("xss")</script><img src="x" onerror="alert(1)" />';
      render(
        <RcvTable
          title="Registro de Ventas"
          type="ventas"
          record={{
            status: 'ok',
            columns: ['Detalle'],
            rows: [[maliciousScript]],
          }}
        />
      );

      // Debe renderizar como texto plano, sin elementos script ni img insertados en el DOM
      expect(screen.getByText(maliciousScript)).toBeInTheDocument();
      expect(document.querySelector('script')).toBeNull();
      expect(document.querySelector('img[src="x"]')).toBeNull();
    });

    it('muestra estado vacío (sin movimientos) apropiado', () => {
      render(
        <RcvTable
          title="Registro de Ventas"
          type="ventas"
          record={{
            status: 'empty',
            columns: [],
            rows: [],
          }}
        />
      );

      expect(screen.getByTestId('status-ventas')).toHaveTextContent(/sin movimientos/i);
      expect(screen.getByText(/sin movimientos para el período/i)).toBeInTheDocument();
      expect(screen.getByText(/no se registran documentos en el período consultado/i)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('soporta 20.000 filas sin advertencias de memoria ni DOM masivo mediante virtualización', () => {
      // Simular array de 20.000 filas
      const largeRows = Array.from({ length: 20000 }, (_, i) => [`COD-${i + 1}`, `Item ${i + 1}`]);
      render(
        <RcvTable
          title="Registro de Compras"
          type="compras"
          record={{
            status: 'ok',
            columns: ['Código', 'Descripción'],
            rows: largeRows,
          }}
        />
      );

      // No debe enunciar advertencias de internals/memoria
      expect(screen.queryByText(/visualizando/i)).toBeNull();
      expect(screen.queryByText(/consumo de memoria/i)).toBeNull();

      // Debe incluir atributos de accesibilidad para la escala completa
      const table = screen.getByRole('table');
      expect(table).toHaveAttribute('aria-rowcount', '20001');
      expect(table).toHaveAttribute('aria-colcount', '2');
      expect(screen.getByTestId('status-compras')).toHaveTextContent('20000 registros');
    });
  });

  describe('App - Flujos completos e integración', () => {
    it('renderiza título literal y período fijo "Febrero de 2026"', () => {
      render(<App />);
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Registro de compras y ventas');
      expect(screen.getByText(/febrero de 2026/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /obtener registro/i })).toBeInTheDocument();
    });

    it('ejecuta consulta exitosa y renderiza ambas tablas completas con scroll independiente', async () => {
      const mockResult: RcvResult = {
        period: { year: 2026, month: 2 },
        status: 'complete',
        compras: {
          status: 'ok',
          columns: ['Folio', 'Proveedor', 'Total'],
          rows: [['1001', 'Empresa A', '50000']],
        },
        ventas: {
          status: 'ok',
          columns: ['Folio', 'Cliente', 'Total'],
          rows: [['2001', 'Cliente B', '120000']],
        },
      };

      vi.spyOn(apiModule, 'fetchRcv').mockResolvedValueOnce({
        ok: true,
        data: mockResult,
      });

      render(<App />);

      fireEvent.change(screen.getByLabelText(/^RUT/i), { target: { value: '11.111.111-1' } });
      fireEvent.change(screen.getByLabelText(/^Contraseña/i), { target: { value: 'secreto' } });
      fireEvent.click(screen.getByRole('button', { name: /obtener registro/i }));

      // Estado de carga visible
      expect(screen.getByRole('status')).toHaveTextContent(/consultando y descargando registros/i);

      // Esperar resolución
      await waitFor(() => {
        expect(screen.getByText('Consulta finalizada correctamente.')).toBeInTheDocument();
      });

      expect(screen.getByText('Registro de Compras')).toBeInTheDocument();
      expect(screen.getByText('Registro de Ventas')).toBeInTheDocument();
      expect(screen.getByText('Empresa A')).toBeInTheDocument();
      expect(screen.getByText('Cliente B')).toBeInTheDocument();
    });

    it('previene doble submit mientras la petición está en curso', async () => {
      let resolveFetch!: (val: apiModule.RcvApiResponse) => void;
      const fetchPromise = new Promise<apiModule.RcvApiResponse>((resolve) => {
        resolveFetch = resolve;
      });

      const fetchSpy = vi.spyOn(apiModule, 'fetchRcv').mockReturnValue(fetchPromise);

      render(<App />);

      fireEvent.change(screen.getByLabelText(/^RUT/i), { target: { value: '11.111.111-1' } });
      fireEvent.change(screen.getByLabelText(/^Contraseña/i), { target: { value: 'secreto' } });
      const submitBtn = screen.getByRole('button', { name: /obtener registro/i });

      fireEvent.click(submitBtn);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Segundo intento de click mientras isLoading = true
      fireEvent.click(submitBtn);
      expect(fetchSpy).toHaveBeenCalledTimes(1); // No incrementa

      // Resolver
      await act(async () => {
        resolveFetch({
          ok: true,
          data: {
            period: { year: 2026, month: 2 },
            status: 'complete',
            compras: { status: 'empty', columns: [], rows: [] },
            ventas: { status: 'empty', columns: [], rows: [] },
          },
        });
      });

      await waitFor(() => {
        expect(screen.queryByText(/consultando y descargando registros/i)).not.toBeInTheDocument();
      });
    });

    it('maneja error 429 con countdown y deshabilita el botón durante el plazo', async () => {
      vi.useFakeTimers();

      vi.spyOn(apiModule, 'fetchRcv').mockResolvedValueOnce({
        ok: false,
        status: 429,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Debe esperar 15 segundos entre cada consulta.',
          retryAfterSeconds: 15,
        },
      });

      render(<App />);

      fireEvent.change(screen.getByLabelText(/^RUT/i), { target: { value: '11.111.111-1' } });
      fireEvent.change(screen.getByLabelText(/^Contraseña/i), { target: { value: 'secreto' } });
      const submitBtn = screen.getByRole('button', { name: /obtener registro/i });

      await act(async () => {
        fireEvent.click(submitBtn);
      });

      const banner = screen.getByRole('alert');
      expect(banner).toHaveTextContent(/15 segundos/i);
      expect(submitBtn).toBeDisabled();

      // Avanzar 5 segundos
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(banner).toHaveTextContent(/10 segundos/i);
      expect(submitBtn).toBeDisabled();

      // Avanzar los 10 restantes
      act(() => {
        vi.advanceTimersByTime(10000);
      });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(submitBtn).not.toBeDisabled();
    });

    it('muestra estado partial cuando un registro falla y el otro tiene éxito', async () => {
      const partialResult: RcvResult = {
        period: { year: 2026, month: 2 },
        status: 'partial',
        compras: {
          status: 'ok',
          columns: ['Folio'],
          rows: [['123']],
        },
        ventas: {
          status: 'error',
          error: {
            code: 'VENTAS_ERROR',
            message: 'Timeout descargando archivo de ventas',
          },
        },
      };

      vi.spyOn(apiModule, 'fetchRcv').mockResolvedValueOnce({
        ok: true,
        data: partialResult,
      });

      render(<App />);

      fireEvent.change(screen.getByLabelText(/^RUT/i), { target: { value: '11.111.111-1' } });
      fireEvent.change(screen.getByLabelText(/^Contraseña/i), { target: { value: 'secreto' } });
      fireEvent.click(screen.getByRole('button', { name: /obtener registro/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/solo uno de los dos registros pudo ser obtenido completamente/i)
        ).toBeInTheDocument();
      });

      expect(screen.getByText('Timeout descargando archivo de ventas')).toBeInTheDocument();
      expect(screen.getByTestId('status-ventas')).toHaveTextContent(/error al consultar/i);
      expect(screen.getByTestId('status-compras')).toHaveTextContent(/1 registros/i);
    });

    it('captura errores de JSON null o malformado mostrando error seguro sin lanzar TypeError raw', async () => {
      // Mock de fetch global retornando null/malformed JSON
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => null,
      });

      render(<App />);

      fireEvent.change(screen.getByLabelText(/^RUT/i), { target: { value: '11.111.111-1' } });
      fireEvent.change(screen.getByLabelText(/^Contraseña/i), { target: { value: 'secreto' } });
      fireEvent.click(screen.getByRole('button', { name: /obtener registro/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });

      expect(screen.getByRole('alert')).toHaveTextContent(/formato no reconocido|inesperada/i);
      expect(screen.queryByText(/TypeError/i)).toBeNull();

      global.fetch = originalFetch;
    });

    it('captura errores de validación de schema (ej: período distinto a 2026/02) mostrando error seguro', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          period: { year: 2025, month: 1 }, // Inválido según schema local
          status: 'complete',
          compras: { status: 'empty', columns: [], rows: [] },
          ventas: { status: 'empty', columns: [], rows: [] },
        }),
      });

      render(<App />);

      fireEvent.change(screen.getByLabelText(/^RUT/i), { target: { value: '11.111.111-1' } });
      fireEvent.change(screen.getByLabelText(/^Contraseña/i), { target: { value: 'secreto' } });
      fireEvent.click(screen.getByRole('button', { name: /obtener registro/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });

      expect(screen.getByRole('alert')).toHaveTextContent(/Estructura de respuesta inesperada del servidor/i);
      expect(screen.queryByText(/TypeError/i)).toBeNull();

      global.fetch = originalFetch;
    });

    it('renderiza consulta exitosa cuando Compras tiene registros y Ventas no tiene movimientos, preservando Compras', async () => {
      vi.spyOn(apiModule, 'fetchRcv').mockResolvedValueOnce({
        ok: true,
        data: {
          period: { year: 2026, month: 2 },
          status: 'complete',
          compras: {
            status: 'ok',
            columns: ['RUT Emisor', 'Folio', 'Monto Total'],
            rows: [
              ['76.111.222-3', '1234', '150000'],
              ['77.333.444-5', '5678', '85000'],
            ],
          },
          ventas: {
            status: 'empty',
            columns: [],
            rows: [],
          },
        },
      });

      render(<App />);

      fireEvent.change(screen.getByLabelText(/^RUT/i), { target: { value: '11.111.111-1' } });
      fireEvent.change(screen.getByLabelText(/^Contraseña/i), { target: { value: 'secreto' } });
      fireEvent.click(screen.getByRole('button', { name: /obtener registro/i }));

      await waitFor(() => {
        expect(screen.getByText(/consulta finalizada correctamente/i)).toBeInTheDocument();
      });

      // Compras debe preservarse intacto con sus registros
      expect(screen.getByTestId('status-compras')).toHaveTextContent(/2 registros/i);
      expect(screen.getByText('76.111.222-3')).toBeInTheDocument();
      expect(screen.getByText('77.333.444-5')).toBeInTheDocument();

      // Ventas debe mostrar badge y mensaje de sin movimientos, sin alerta de error
      expect(screen.getByTestId('status-ventas')).toHaveTextContent(/sin movimientos/i);
      const emptyVentasContainer = screen.getByTestId('empty-ventas');
      expect(emptyVentasContainer).toHaveTextContent(/sin movimientos para el período/i);
      expect(emptyVentasContainer).toHaveTextContent(/no se registran documentos en el período consultado/i);
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('renderiza consulta exitosa cuando ambos registros están vacíos (sin movimientos) con banner de finalización completa', async () => {
      vi.spyOn(apiModule, 'fetchRcv').mockResolvedValueOnce({
        ok: true,
        data: {
          period: { year: 2026, month: 2 },
          status: 'complete',
          compras: { status: 'empty', columns: [], rows: [] },
          ventas: { status: 'empty', columns: [], rows: [] },
        },
      });

      render(<App />);

      fireEvent.change(screen.getByLabelText(/^RUT/i), { target: { value: '11.111.111-1' } });
      fireEvent.change(screen.getByLabelText(/^Contraseña/i), { target: { value: 'secreto' } });
      fireEvent.click(screen.getByRole('button', { name: /obtener registro/i }));

      await waitFor(() => {
        expect(screen.getByText(/consulta finalizada correctamente/i)).toBeInTheDocument();
      });

      expect(screen.getByTestId('status-compras')).toHaveTextContent(/sin movimientos/i);
      expect(screen.getByTestId('status-ventas')).toHaveTextContent(/sin movimientos/i);
      expect(screen.getByTestId('empty-compras')).toHaveTextContent(/sin movimientos para el período/i);
      expect(screen.getByTestId('empty-ventas')).toHaveTextContent(/sin movimientos para el período/i);
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});
