import http, { type Server } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BrowserSession } from '../../server/src/infrastructure/sii/browserSession.js';

function createLoopbackServer(): Server {
  return http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="utf-8" />
          <title>Loopback Fixture SII</title>
        </head>
        <body>
          <h1>Loopback Fixture</h1>
          <form id="test-form">
            <label for="rut">RUT:</label>
            <input id="rut" name="rut" type="text" />
          </form>
          <a id="download-csv" href="/descarga.csv" download="reporte_rcv.csv">Descargar CSV</a>
        </body>
        </html>
      `);
      return;
    }

    if (req.url === '/descarga.csv') {
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="reporte_rcv.csv"',
      });
      res.end('RUT;Periodo;Monto\n11111111-1;202501;150000\n');
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });
}

async function verifyDownloadedCsv(downloadsPath: string): Promise<void> {
  const downloadTimeoutLimit = Date.now() + 10000;

  while (Date.now() < downloadTimeoutLimit) {
    const files = await fs.readdir(downloadsPath);
    const crdownloads = files.filter((f) => f.endsWith('.crdownload'));
    const csvFiles = files.filter((f) => f.endsWith('.csv'));

    if (csvFiles.length > 0 && crdownloads.length === 0) {
      const filePath = path.join(downloadsPath, csvFiles[0]!);
      const stats = await fs.stat(filePath);
      if (stats.size > 0) {
        const content = await fs.readFile(filePath, 'utf-8');
        console.log(
          `[smoke-test] Archivo descargado exitosamente: "${csvFiles[0]}" (${stats.size} bytes)`,
        );
        if (content.includes('11111111-1;202501;150000')) {
          return;
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error('No se pudo verificar el archivo CSV descargado.');
}

async function verifySessionProperties(session: BrowserSession): Promise<void> {
  console.log('[smoke-test] Verificando propiedades de la sesión:');
  console.log('  - page presente:', Boolean(session.page));
  console.log('  - browser presente:', Boolean(session.browser));
  console.log('  - stagehand presente:', Boolean(session.stagehand));
  console.log('  - downloadsPath:', session.downloadsPath);
  console.log('  - tempRoot:', session.tempRoot);

  if (
    !session.page ||
    !session.browser ||
    !session.stagehand ||
    !session.downloadsPath ||
    !session.tempRoot
  ) {
    throw new Error('BrowserSession no expone todas las propiedades requeridas.');
  }
}

async function runNavigationAndDownload(
  session: BrowserSession,
  loopbackUrl: string,
): Promise<void> {
  console.log(`[smoke-test] Navegando a ${loopbackUrl}...`);
  await session.page.goto(loopbackUrl);

  const title = await session.page.title();
  console.log(`[smoke-test] Título de página: "${title}"`);
  if (title !== 'Loopback Fixture SII') {
    throw new Error(`Título inesperado: ${title}`);
  }

  console.log('[smoke-test] Rellenando campo de texto (#rut)...');
  const rutInput = session.page.locator('#rut');
  await rutInput.fill('11111111-1');

  console.log('[smoke-test] Haciendo click en enlace de descarga (#download-csv)...');
  const downloadLink = session.page.locator('#download-csv');
  await downloadLink.click();

  console.log('[smoke-test] Esperando y verificando descarga de CSV...');
  await verifyDownloadedCsv(session.downloadsPath);
}

const server = createLoopbackServer();
await new Promise<void>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve());
});

const address = server.address();
if (!address || typeof address === 'string') {
  server.close();
  throw new Error('No se pudo determinar el puerto del servidor loopback.');
}

const loopbackUrl = `http://127.0.0.1:${address.port}/`;
console.log(`[smoke-test] Servidor loopback escuchando en ${loopbackUrl}`);

let session: BrowserSession | undefined;

const testTimeout = setTimeout(() => {
  console.error('[smoke-test] ERROR: Tiempo de espera excedido (>60s)');
  process.exit(1);
}, 60000);

try {
  console.log('[smoke-test] Iniciando BrowserSession...');
  session = await BrowserSession.start({
    headless: true,
  });

  await verifySessionProperties(session);
  await runNavigationAndDownload(session, loopbackUrl);

  const tempRootToCheck = session.tempRoot;

  console.log('[smoke-test] Cerrando BrowserSession...');
  await session.close();
  session = undefined;

  console.log('[smoke-test] Verificando que tempRoot haya sido limpiado...');
  try {
    await fs.access(tempRootToCheck);
    throw new Error(`tempRoot todavía existe tras cerrar la sesión: ${tempRootToCheck}`);
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      console.log('[smoke-test] Limpieza de tempRoot confirmada (ENOENT).');
    } else {
      throw err;
    }
  }

  console.log('[smoke-test] OK: Prueba de humo completada con éxito.');
} finally {
  clearTimeout(testTimeout);

  if (session) {
    try {
      await session.close();
    } catch (err) {
      console.error('[smoke-test] Error cerrando sesión en finally:', err);
    }
  }

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  console.log('[smoke-test] Servidor loopback detenido.');
}
