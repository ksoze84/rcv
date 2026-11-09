import { test, expect } from '@playwright/test';

const SYNTHETIC_RUT = '11111111-1';
const SYNTHETIC_PASSWORD = 'TestPassword123!';

const mockSuccessResponse = {
  period: { year: 2026, month: 2 },
  status: 'complete',
  compras: {
    status: 'ok',
    columns: ['Folio', 'RUT Emisor', 'Razón Social', 'Monto Total'],
    rows: [
      ['1001', '76.123.456-7', 'Proveedor Alfa SpA', '$150.000'],
      ['1002', '77.234.567-8', 'Servicios Beta Ltda', '$89.900'],
    ],
  },
  ventas: {
    status: 'ok',
    columns: ['Folio', 'RUT Receptor', 'Razón Social', 'Monto Total'],
    rows: [
      ['2001', '12.345.678-9', 'Cliente Gamma SpA', '$540.000'],
      ['2002', '13.456.789-0', 'Distribuidora Delta', '$1.250.000'],
    ],
  },
};

test.describe('RCV E2E - Flujos y Casos Críticos', () => {
  test('singlebutton: verifica interfaz simple con un único botón de acción', async ({ page }) => {
    await page.goto('/');

    const buttons = page.locator('button');
    await expect(buttons).toHaveCount(1);
    await expect(buttons.first()).toHaveText(/obtener registro/i);
  });

  test('secret clearing: borra inmediatamente la contraseña al enviar sin registrarla', async ({ page }) => {
    await page.route('/api/rcv', async (route) => {
      // Simular delay de 100ms
      await new Promise((resolve) => setTimeout(resolve, 100));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockSuccessResponse),
      });
    });

    await page.goto('/');

    const rutInput = page.locator('input[name="rut"]');
    const passwordInput = page.locator('input[name="password"]');
    const submitBtn = page.getByRole('button', { name: /obtener registro/i });

    await rutInput.fill(SYNTHETIC_RUT);
    await passwordInput.fill(SYNTHETIC_PASSWORD);

    await expect(passwordInput).toHaveValue(SYNTHETIC_PASSWORD);

    await submitBtn.click();

    // Inmediatamente tras click, el input de contraseña debe estar vacío
    await expect(passwordInput).toHaveValue('');
    // El RUT se mantiene intacto
    await expect(rutInput).toHaveValue(SYNTHETIC_RUT);
  });

  test('success: consulta exitosa con período Febrero 2026 y renderizado de compras y ventas', async ({ page }) => {
    await page.route('/api/rcv', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockSuccessResponse),
      });
    });

    await page.goto('/');

    await page.locator('input[name="rut"]').fill(SYNTHETIC_RUT);
    await page.locator('input[name="password"]').fill(SYNTHETIC_PASSWORD);
    await page.getByRole('button', { name: /obtener registro/i }).click();

    // Banner de estado global
    await expect(page.locator('.status-complete')).toBeVisible();
    await expect(page.locator('.status-complete')).toHaveText(/consulta finalizada correctamente/i);

    // Ambas tablas
    await expect(page.getByRole('heading', { name: 'Registro de Compras', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Registro de Ventas', exact: true })).toBeVisible();

    // Badges y datos
    await expect(page.getByTestId('status-compras')).toHaveText('2 registros');
    await expect(page.getByTestId('status-ventas')).toHaveText('2 registros');
    await expect(page.getByText('Proveedor Alfa SpA')).toBeVisible();
    await expect(page.getByText('Cliente Gamma SpA')).toBeVisible();

    // Screenshot sintético
    await page.screenshot({ path: 'test-results/e2e-success.png' });
  });

  test('partial: muestra banner parcial y detalle cuando un registro falla', async ({ page }) => {
    const mockPartial = {
      period: { year: 2026, month: 2 },
      status: 'partial',
      compras: {
        status: 'ok',
        columns: ['Folio', 'Monto'],
        rows: [['101', '$50.000']],
      },
      ventas: {
        status: 'error',
        error: {
          code: 'VENTAS_TIMEOUT',
          message: 'Error al descargar registro de ventas desde SII',
        },
      },
    };

    await page.route('/api/rcv', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockPartial),
      });
    });

    await page.goto('/');
    await page.locator('input[name="rut"]').fill(SYNTHETIC_RUT);
    await page.locator('input[name="password"]').fill(SYNTHETIC_PASSWORD);
    await page.getByRole('button', { name: /obtener registro/i }).click();

    await expect(page.locator('.status-partial')).toBeVisible();
    await expect(page.locator('.status-partial')).toHaveText(/solo uno de los dos registros pudo ser obtenido/i);

    await expect(page.getByTestId('status-compras')).toHaveText('1 registros');
    await expect(page.getByTestId('status-ventas')).toHaveText('Error al consultar');
    await expect(page.getByText('Error al descargar registro de ventas desde SII')).toBeVisible();

    await page.screenshot({ path: 'test-results/e2e-partial.png' });
  });

  test('429: muestra enfriamiento y deshabilita botón durante el countdown', async ({ page }) => {
    await page.route('/api/rcv', async (route) => {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        headers: {
          'Retry-After': '15',
        },
        body: JSON.stringify({
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Debe esperar 15 segundos entre cada consulta.',
            retryAfterSeconds: 15,
          },
        }),
      });
    });

    await page.goto('/');
    await page.locator('input[name="rut"]').fill(SYNTHETIC_RUT);
    await page.locator('input[name="password"]').fill(SYNTHETIC_PASSWORD);
    const submitBtn = page.getByRole('button', { name: /obtener registro/i });
    await submitBtn.click();

    const banner = page.locator('.rate-limit-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/15/);
    await expect(submitBtn).toBeDisabled();

    await page.screenshot({ path: 'test-results/e2e-429.png' });
  });

  test('columnasduplicadas: maneja columnas con nombres repetidos sin error', async ({ page }) => {
    const mockDuplicateColumns = {
      period: { year: 2026, month: 2 },
      status: 'complete',
      compras: {
        status: 'ok',
        columns: ['Folio', 'Monto', 'Monto', 'Fecha'],
        rows: [['999', '$100', '$119', '2026-02-15']],
      },
      ventas: {
        status: 'empty',
        columns: [],
        rows: [],
      },
    };

    await page.route('/api/rcv', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockDuplicateColumns),
      });
    });

    await page.goto('/');
    await page.locator('input[name="rut"]').fill(SYNTHETIC_RUT);
    await page.locator('input[name="password"]').fill(SYNTHETIC_PASSWORD);
    await page.getByRole('button', { name: /obtener registro/i }).click();

    const comprasSection = page.locator('section[aria-labelledby="title-compras"]');
    const montos = comprasSection.getByRole('columnheader', { name: 'Monto' });
    await expect(montos).toHaveCount(2);

    await page.screenshot({ path: 'test-results/e2e-columnas-duplicadas.png' });
  });

  test('no body horizontal overflow a360 y1440', async ({ page }) => {
    const mockWideTable = {
      period: { year: 2026, month: 2 },
      status: 'complete',
      compras: {
        status: 'ok',
        columns: [
          'Columna Extensa 1',
          'Columna Extensa 2',
          'Columna Extensa 3',
          'Columna Extensa 4',
          'Columna Extensa 5',
          'Columna Extensa 6',
          'Columna Extensa 7',
          'Columna Extensa 8',
        ],
        rows: [
          [
            'Dato muy largo A123456789',
            'Dato muy largo B123456789',
            'Dato muy largo C123456789',
            'Dato muy largo D123456789',
            'Dato muy largo E123456789',
            'Dato muy largo F123456789',
            'Dato muy largo G123456789',
            'Dato muy largo H123456789',
          ],
        ],
      },
      ventas: {
        status: 'empty',
        columns: [],
        rows: [],
      },
    };

    await page.route('/api/rcv', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockWideTable),
      });
    });

    // Probar a 360px móvil
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto('/');
    await page.locator('input[name="rut"]').fill(SYNTHETIC_RUT);
    await page.locator('input[name="password"]').fill(SYNTHETIC_PASSWORD);
    await page.getByRole('button', { name: /obtener registro/i }).click();

    await expect(page.locator('.status-complete')).toBeVisible();

    const isBodyOverflowingAt360 = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth ||
             document.body.scrollWidth > window.innerWidth;
    });
    expect(isBodyOverflowingAt360).toBe(false);

    // El contenedor de tabla sí debe tener scroll horizontal propio
    const tableScrollContainer = page.locator('.table-scroll-container').first();
    const isContainerScrollable = await tableScrollContainer.evaluate(
      (el) => el.scrollWidth > el.clientWidth
    );
    expect(isContainerScrollable).toBe(true);

    await page.screenshot({ path: 'test-results/e2e-no-overflow-360.png' });

    // Probar a 1440px desktop
    await page.setViewportSize({ width: 1440, height: 900 });
    const isBodyOverflowingAt1440 = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth ||
             document.body.scrollWidth > window.innerWidth;
    });
    expect(isBodyOverflowingAt1440).toBe(false);

    await page.screenshot({ path: 'test-results/e2e-no-overflow-1440.png' });
  });

  test('20000rows inicio/fin scroll: virtualización eficiente sin DOM masivo', async ({ page }) => {
    // Generar 20.000 filas sintéticas
    const rowCount = 20000;
    const generatedRows: string[][] = [];
    for (let i = 1; i <= rowCount; i++) {
      generatedRows.push([`DOC-${i}`, `76.${i.toString().padStart(6, '0')}-K`, `Proveedor ${i}`, `$${i * 1000}`]);
    }

    const mock20k = {
      period: { year: 2026, month: 2 },
      status: 'complete',
      compras: {
        status: 'ok',
        columns: ['Folio', 'RUT', 'Proveedor', 'Monto'],
        rows: generatedRows,
      },
      ventas: {
        status: 'empty',
        columns: [],
        rows: [],
      },
    };

    await page.route('/api/rcv', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mock20k),
      });
    });

    await page.goto('/');
    await page.locator('input[name="rut"]').fill(SYNTHETIC_RUT);
    await page.locator('input[name="password"]').fill(SYNTHETIC_PASSWORD);
    await page.getByRole('button', { name: /obtener registro/i }).click();

    await expect(page.getByTestId('status-compras')).toHaveText('20000 registros');

    // Verificar accesibilidad aria-rowcount
    const table = page.locator('.rcv-data-table');
    await expect(table).toHaveAttribute('aria-rowcount', '20001');

    // Inicio: Fila 1 debe estar visible en DOM
    await expect(page.getByTitle('DOC-1', { exact: true })).toBeVisible();

    // DOM no debe ser masivo: el total de <tr> en el tbody debe ser pequeño (~30 a 50 filas)
    const domRowCountInitial = await page.locator('.rcv-data-table tbody tr').count();
    expect(domRowCountInitial).toBeLessThan(100);

    // Fila 20.000 NO debe existir todavía en el DOM
    await expect(page.getByTitle('DOC-20000', { exact: true })).toHaveCount(0);

    // Scrollear el contenedor de la tabla hasta el final
    const scrollContainer = page.locator('.table-scroll-container').first();
    await scrollContainer.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });

    // Fin: Fila 20.000 debe estar ahora renderizada y visible en DOM
    await expect(page.getByTitle('DOC-20000', { exact: true })).toBeVisible();

    // Fila 1 ya fue desmontada por virtualización
    await expect(page.getByTitle('DOC-1', { exact: true })).toHaveCount(0);

    // El conteo de filas en el DOM sigue siendo pequeño
    const domRowCountEnd = await page.locator('.rcv-data-table tbody tr').count();
    expect(domRowCountEnd).toBeLessThan(100);

    await page.screenshot({ path: 'test-results/e2e-20k-rows-bottom.png' });
  });
});
