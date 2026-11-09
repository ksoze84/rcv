import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JSDOM } from 'jsdom';
import { captureDownload, parseDataUriToBytes } from '../src/infrastructure/sii/captureDownload.js';
import { AppError } from '../src/domain/errors.js';
import { SiiPageLike } from '../src/infrastructure/sii/siiPage.js';
import { parseRcvCsv } from '../src/infrastructure/csv/parseRcvCsv.js';

describe('captureDownload helper', () => {
  let tempRoot: string;
  let downloadsDir: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'test-capture-download-'));
    downloadsDir = path.join(tempRoot, 'downloads');
    await fs.mkdir(downloadsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('captures a downloaded file successfully and returns Uint8Array', async () => {
    const fakeSession = { downloadsPath: downloadsDir };
    const expectedCsv = 'RUT;Monto\n11111111-1;500';

    const triggerAction = async () => {
      // Simulate trigger initiating download
      const targetFile = path.join(downloadsDir, 'reporte.csv');
      await fs.writeFile(targetFile, expectedCsv, 'utf-8');
    };

    const result = await captureDownload({
      downloadsPath: fakeSession.downloadsPath,
      action: triggerAction,
      signal: new AbortController().signal,
      maxBytes: 10 * 1024 * 1024,
      pollIntervalMs: 20,
      timeoutMs: 1000,
    });

    expect(new TextDecoder().decode(result)).toBe(expectedCsv);
  });

  it('fails if download times out', async () => {
    const fakeSession = { downloadsPath: downloadsDir };
    const triggerAction = async () => {
      // No file created
    };

    await expect(
      captureDownload({
        downloadsPath: fakeSession.downloadsPath,
        action: triggerAction,
        signal: new AbortController().signal,
        maxBytes: 1024,
        pollIntervalMs: 20,
        timeoutMs: 100,
      })
    ).rejects.toThrow(AppError);
  });

  it('aborts cleanly if signal is triggered', async () => {
    const fakeSession = { downloadsPath: downloadsDir };
    const controller = new AbortController();

    const triggerAction = async () => {
      setTimeout(() => controller.abort(), 30);
    };

    await expect(
      captureDownload({
        downloadsPath: fakeSession.downloadsPath,
        action: triggerAction,
        signal: controller.signal,
        maxBytes: 1024,
        pollIntervalMs: 20,
        timeoutMs: 1000,
      })
    ).rejects.toThrow();
  });

  it('cleans preexisting files in downloads directory before capture', async () => {
    const preexisting = path.join(downloadsDir, 'old.csv');
    await fs.writeFile(preexisting, 'old', 'utf-8');

    const expectedCsv = 'RUT;Monto\n22222222-2;1000';
    const triggerAction = async () => {
      const targetFile = path.join(downloadsDir, 'new.csv');
      await fs.writeFile(targetFile, expectedCsv, 'utf-8');
    };

    const result = await captureDownload({
      downloadsPath: downloadsDir,
      action: triggerAction,
      signal: new AbortController().signal,
      maxBytes: 1024,
      pollIntervalMs: 20,
      timeoutMs: 1000,
    });

    expect(new TextDecoder().decode(result)).toBe(expectedCsv);
    const files = await fs.readdir(downloadsDir);
    expect(files).not.toContain('old.csv');
  });

  it('rejects files exceeding maxBytes', async () => {
    const triggerAction = async () => {
      const targetFile = path.join(downloadsDir, 'large.csv');
      await fs.writeFile(targetFile, Buffer.alloc(2000), 'utf-8');
    };

    await expect(
      captureDownload({
        downloadsPath: downloadsDir,
        action: triggerAction,
        signal: new AbortController().signal,
        maxBytes: 1000,
        pollIntervalMs: 20,
        timeoutMs: 1000,
      })
    ).rejects.toThrow(AppError);
  });

  it('extrae el nuevo Data URI ignorando enlaces preexistentes y elimina el enlace del DOM', async () => {
    const dom = new JSDOM(`
      <!DOCTYPE html>
      <html>
        <body>
          <a id="oldLink" href="data:text/csv;charset=utf-8,OLD_DATA">Descarga Anterior</a>
        </body>
      </html>
    `);

    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (arg?: unknown) => unknown, arg?: unknown) => {
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

    const newCsvData = 'Nro;Tipo Doc;RUT Proveedor\n1;33;76123456-7';
    const encodedNewHref = `data:text/csv;charset=utf-8,${encodeURIComponent(newCsvData)}`;

    const triggerAction = async () => {
      const a = dom.window.document.createElement('a');
      a.id = 'newLink';
      a.href = encodedNewHref;
      dom.window.document.body.appendChild(a);
    };

    const result = await captureDownload({
      downloadsPath: downloadsDir,
      page: fakePage,
      action: triggerAction,
      signal: new AbortController().signal,
      maxBytes: 10 * 1024 * 1024,
      pollIntervalMs: 20,
      dataUriTimeoutMs: 1000,
    });

    expect(new TextDecoder().decode(result)).toBe(newCsvData);
    // Verificar que el nuevo enlace fue removido del DOM para no confundir la siguiente pestaña
    expect(dom.window.document.getElementById('newLink')).toBeNull();
    // El enlace preexistente no fue alterado
    expect(dom.window.document.getElementById('oldLink')).not.toBeNull();
  });

  it('soporta delimitador ";" y salto de linea %0A con caracteres especiales decodificados y alimenta parseRcvCsv', async () => {
    const rawData = 'Nro;Tipo%20Doc;Tipo%20Compra;RUT%20Proveedor;Razon%20Social;%0A1;33;1;12345678-5;EMPRESA%20PRUEBA%20SPA;%0A2;34;1;76123456-0;OTRA%20EMPRESA;';
    const dataUri = `data:text/csv;charset=utf-8,${rawData}`;

    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (arg?: unknown) => unknown, arg?: unknown) => {
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

    const triggerAction = async () => {
      const a = dom.window.document.createElement('a');
      a.href = dataUri;
      dom.window.document.body.appendChild(a);
    };

    const result = await captureDownload({
      downloadsPath: downloadsDir,
      page: fakePage,
      action: triggerAction,
      signal: new AbortController().signal,
      pollIntervalMs: 20,
      dataUriTimeoutMs: 1000,
    });

    const decoded = new TextDecoder().decode(result);
    expect(decoded).toContain('Nro;Tipo Doc;Tipo Compra;RUT Proveedor;Razon Social;');
    expect(decoded).toContain('\n1;33;1;12345678-5;EMPRESA PRUEBA SPA;');
    expect(decoded).toContain('\n2;34;1;76123456-0;OTRA EMPRESA;');

    const parsed = parseRcvCsv(result);
    expect(parsed.status).toBe('ok');
    expect(parsed.rows.length).toBe(2);
    expect(parsed.columns).toContain('RUT Proveedor');
    const rutIndex = parsed.columns.indexOf('RUT Proveedor');
    expect(parsed.rows[0]?.[rutIndex]).toBe('12345678-5');
    expect(parsed.rows[1]?.[rutIndex]).toBe('76123456-0');
  });

  it('lanza CSV_TOO_LARGE si la longitud del data URI excede maxCsvBytes ANTES de materializar', async () => {
    const hugePayload = 'Nro;Tipo;RUT;%0A'.repeat(50);
    const dataUri = `data:text/csv;charset=utf-8,${encodeURIComponent(hugePayload)}`;

    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (arg?: unknown) => unknown, arg?: unknown) => {
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

    const triggerAction = async () => {
      const a = dom.window.document.createElement('a');
      a.href = dataUri;
      dom.window.document.body.appendChild(a);
    };

    let caughtErr: unknown;
    try {
      await captureDownload({
        downloadsPath: downloadsDir,
        page: fakePage,
        action: triggerAction,
        signal: new AbortController().signal,
        maxBytes: 100, // Limite estricto de 100 bytes
        pollIntervalMs: 20,
        dataUriTimeoutMs: 1000,
      });
    } catch (err) {
      caughtErr = err;
    }

    expect(caughtErr).toBeInstanceOf(AppError);
    expect((caughtErr as AppError).code).toBe('CSV_TOO_LARGE');
    // NUNCA debe registrar ni filtrar el contenido del Data URI
    expect((caughtErr as AppError).message).not.toContain('Nro;Tipo;RUT');
  });

  it('hace fallback a archivo en downloadsPath si no aparece ningun data URI en el DOM', async () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body><p>Sin enlace</p></body></html>');
    const fakePage: SiiPageLike = {
      url: () => 'https://www4.sii.cl/consdcvinternetui/#/index',
      evaluate: vi.fn().mockImplementation(async (fn: (arg?: unknown) => unknown, arg?: unknown) => {
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

    const expectedFileCsv = 'RUT;Monto\n33333333-3;9990';
    const triggerAction = async () => {
      const targetFile = path.join(downloadsDir, 'fallback.csv');
      await fs.writeFile(targetFile, expectedFileCsv, 'utf-8');
    };

    const result = await captureDownload({
      downloadsPath: downloadsDir,
      page: fakePage,
      action: triggerAction,
      signal: new AbortController().signal,
      maxBytes: 10 * 1024 * 1024,
      pollIntervalMs: 20,
      dataUriTimeoutMs: 100,
      timeoutMs: 1000,
    });

    expect(new TextDecoder().decode(result)).toBe(expectedFileCsv);
  });

  it('parseDataUriToBytes decodifica directamente respetando charset ISO-8859-1 y Base64', () => {
    // ISO-8859-1 test: %F3 es 'ó' en ISO-8859-1 (0xF3)
    const isoDataUri = 'data:text/csv;charset=iso-8859-1,RUT;Raz%F3n%20Social%0A1-9;Prueba%20A';
    const isoBytes = parseDataUriToBytes(isoDataUri, 1024);
    expect(isoBytes).toBeInstanceOf(Uint8Array);

    // Base64 test
    const base64Content = Buffer.from('Col1;Col2\nVal1;Val2', 'utf-8').toString('base64');
    const base64DataUri = `data:text/csv;charset=utf-8;base64,${base64Content}`;
    const base64Bytes = parseDataUriToBytes(base64DataUri, 1024);
    expect(new TextDecoder().decode(base64Bytes)).toBe('Col1;Col2\nVal1;Val2');
  });
});
