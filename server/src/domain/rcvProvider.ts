import { Credentials, PublicError } from '../../../shared/rcv.js';

export type DownloadResult =
  | { status: 'downloaded'; bytes: Uint8Array }
  | { status: 'empty' }
  | { status: 'error'; error: PublicError };

export interface RcvDownloads {
  compras: DownloadResult;
  ventas: DownloadResult;
}

export interface RcvProvider {
  fetch(credentials: Credentials, signal: AbortSignal): Promise<RcvDownloads>;
  close(): Promise<void>;
}
