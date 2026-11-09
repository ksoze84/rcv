import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { promises as dns } from 'node:dns';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import {
  localBrowser,
  Page,
  Stagehand,
  type StagehandBrowser,
} from '@browserbasehq/stagehand';

export const SII_HOSTS = [
  'www.sii.cl',
  'zeusr.sii.cl',
  'www4.sii.cl',
  'homer.sii.cl',
  'accounts.claveunica.gob.cl',
  'claveunica.gob.cl',
];

export interface BrowserSessionOptions {
  chromePath?: string;
  headless: boolean;
  extraArgs?: string[];
  disableHostResolverRules?: boolean;
}

export class BrowserSession {
  public readonly page: Page;
  public readonly browser: StagehandBrowser;
  public readonly stagehand: Stagehand;
  public readonly downloadsPath: string;
  public readonly tempRoot: string;

  private constructor(
    page: Page,
    browser: StagehandBrowser,
    stagehand: Stagehand,
    downloadsPath: string,
    tempRoot: string,
  ) {
    this.page = page;
    this.browser = browser;
    this.stagehand = stagehand;
    this.downloadsPath = downloadsPath;
    this.tempRoot = tempRoot;
  }

  /**
   * Resuelve previamente en Node los dominios oficiales de SII y Clave Única
   * y construye el argumento --host-resolver-rules para Chromium.
   * Evita fallos de resolución DNS interna en entornos WSL/Linux (DNS_PROBE_STARTED / chrome-error://).
   */
  public static async buildHostResolverRules(hosts: string[] = SII_HOSTS): Promise<string | null> {
    try {
      const mappings = await Promise.all(
        hosts.map(async (host) => {
          try {
            const { address } = await dns.lookup(host);
            return `MAP ${host} ${address}`;
          } catch {
            return null;
          }
        })
      );
      const valid = mappings.filter((m): m is string => Boolean(m));
      return valid.length > 0 ? `--host-resolver-rules=${valid.join(',')}` : null;
    } catch {
      return null;
    }
  }

  public static async start(options: BrowserSessionOptions): Promise<BrowserSession> {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rcv-session-'));
    const downloadsPath = path.join(tempRoot, 'downloads');
    await fs.mkdir(downloadsPath, { recursive: true });

    let browser: StagehandBrowser | undefined;
    let stagehand: Stagehand | undefined;

    try {
      const executablePath = BrowserSession.resolveExecutablePath(options.chromePath);

      const resolverRule = options.disableHostResolverRules
        ? null
        : await BrowserSession.buildHostResolverRules();
      const launchArgs = [
        ...(resolverRule ? [resolverRule] : []),
        ...(options.extraArgs ?? []),
      ];

      browser = await localBrowser.launch({
        executablePath,
        headless: options.headless,
        acceptDownloads: true,
        downloadsPath,
        ...(launchArgs.length > 0 ? { args: launchArgs } : {}),
      });

      stagehand = await Stagehand.create({
        browser,
        selfHeal: false,
        cache: false,
        logging: {
          level: 'off',
        },
      });

      const page =
        (await browser.context.activePage()) ?? (await browser.context.newPage());

      return new BrowserSession(page, browser, stagehand, downloadsPath, tempRoot);
    } catch (error) {
      await BrowserSession.cleanupResources({
        stagehand,
        browser,
        tempRoot,
      });
      throw error;
    }
  }

  public async close(): Promise<void> {
    await BrowserSession.cleanupResources({
      stagehand: this.stagehand,
      browser: this.browser,
      tempRoot: this.tempRoot,
    });
  }

  private static resolveExecutablePath(explicitPath?: string): string {
    if (explicitPath) {
      if (existsSync(explicitPath)) {
        return explicitPath;
      }
      throw new Error(`Executable not found at explicit chromePath: ${explicitPath}`);
    }

    const cacheDir = path.join(os.homedir(), '.cache', 'ms-playwright');
    if (existsSync(cacheDir)) {
      try {
        const entries = readdirSync(cacheDir)
          .filter((entry) => entry.startsWith('chromium-'))
          .sort((a, b) => {
            const numA = Number.parseInt(a.replace('chromium-', ''), 10) || 0;
            const numB = Number.parseInt(b.replace('chromium-', ''), 10) || 0;
            return numB - numA;
          });

        for (const entry of entries) {
          const candidate = path.join(cacheDir, entry, 'chrome-linux64', 'chrome');
          if (existsSync(candidate)) {
            return candidate;
          }
        }
      } catch {
        // Fallback to playwright default
      }
    }

    return chromium.executablePath();
  }

  private static async cleanupResources(resources: {
    stagehand: Stagehand | undefined;
    browser: StagehandBrowser | undefined;
    tempRoot: string | undefined;
  }): Promise<void> {
    const errors: unknown[] = [];

    if (resources.stagehand) {
      try {
        await resources.stagehand.close();
      } catch (err) {
        errors.push(err);
      }
    }

    if (resources.browser && !resources.browser.closed) {
      try {
        await resources.browser.close();
      } catch (err) {
        errors.push(err);
      }
    }

    if (resources.tempRoot) {
      try {
        await fs.rm(resources.tempRoot, { recursive: true, force: true });
      } catch (err) {
        errors.push(err);
      }
    }

    if (errors.length > 0) {
      // If cleanup failed, log or aggregate
      if (errors.length === 1) {
        throw errors[0];
      }
      throw new AggregateError(errors, 'Failed cleaning up browser session resources');
    }
  }
}
