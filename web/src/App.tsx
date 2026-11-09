import React, { useState, useEffect, useRef } from 'react';
import type { Credentials, PublicError, RcvResult } from '../../shared/rcv.js';
import { CredentialsForm } from './components/CredentialsForm.js';
import { RcvTable } from './components/RcvTable.js';
import { fetchRcv } from './api/rcv.js';

export function App(): React.JSX.Element {
  const [isLoading, setIsLoading] = useState(false);
  const [generalError, setGeneralError] = useState<PublicError | null>(null);
  const [data, setData] = useState<RcvResult | null>(null);
  const [retryAfterCountdown, setRetryAfterCountdown] = useState<number | null>(null);

  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef<boolean>(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (activeAbortControllerRef.current) {
        activeAbortControllerRef.current.abort();
      }
    };
  }, []);

  // Manejar cuenta regresiva cuando hay HTTP 429 / retryAfterSeconds
  useEffect(() => {
    if (retryAfterCountdown === null || retryAfterCountdown <= 0) {
      return;
    }

    const timer = setInterval(() => {
      setRetryAfterCountdown((prev) => {
        if (prev === null || prev <= 1) {
          return null;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [retryAfterCountdown]);

  const handleFormSubmit = async (credentials: Credentials) => {
    // Impedir double submit si ya está cargando o bloqueado por countdown
    if (isLoading || (retryAfterCountdown !== null && retryAfterCountdown > 0)) {
      return;
    }

    // Cancelar cualquier petición previa si existiera
    if (activeAbortControllerRef.current) {
      activeAbortControllerRef.current.abort();
    }
    const abortController = new AbortController();
    activeAbortControllerRef.current = abortController;

    setIsLoading(true);
    setGeneralError(null);
    setData(null);

    try {
      const response = await fetchRcv(credentials, { signal: abortController.signal });

      if (!isMountedRef.current) {
        return;
      }

      if (!response.ok) {
        if (response.error.retryAfterSeconds && response.error.retryAfterSeconds > 0) {
          setRetryAfterCountdown(response.error.retryAfterSeconds);
          setGeneralError(null);
        } else {
          setGeneralError(response.error);
        }
      } else {
        setData(response.data);
      }
    } catch (err: unknown) {
      if (!isMountedRef.current) {
        return;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        // Petición cancelada o desmontada
        return;
      }
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'No fue posible conectar con el servidor. Verifique su conexión.';
      setGeneralError({
        code: 'REQUEST_ERROR',
        message,
      });
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
        activeAbortControllerRef.current = null;
      }
    }
  };

  const isFormDisabled = retryAfterCountdown !== null && retryAfterCountdown > 0;

  return (
    <div className="app-layout">
      <header className="app-header">
        <h1 className="app-title">Registro de compras y ventas</h1>
        <div className="app-period" aria-label="Período tributario consultado">
          Período: <span className="period-value">Febrero de 2026</span>
        </div>
      </header>

      <main>
        <CredentialsForm
          onSubmit={handleFormSubmit}
          isLoading={isLoading}
          isDisabled={isFormDisabled}
        />

        {retryAfterCountdown !== null && retryAfterCountdown > 0 && (
          <div className="rate-limit-banner" role="alert" aria-live="polite" style={{ marginTop: '16px' }}>
            <span>
              Límite de solicitudes alcanzado. Podrá intentar nuevamente en{' '}
              <strong>{retryAfterCountdown}</strong> segundos.
            </span>
          </div>
        )}

        {isLoading && (
          <div className="loading-indicator" role="status" style={{ marginTop: '16px' }}>
            <div className="spinner" aria-hidden="true" />
            <span>Consultando y descargando registros del SII...</span>
          </div>
        )}

        {generalError && (retryAfterCountdown === null || retryAfterCountdown <= 0) && (
          <div className="app-error-banner" role="alert" style={{ marginTop: '16px' }}>
            <div className="app-error-title">Error en la consulta</div>
            <div>{generalError.message}</div>
          </div>
        )}

        {data && (
          <div className="results-container" style={{ marginTop: '24px' }}>
            {data.status === 'partial' && (
              <div className="global-status-banner status-partial" role="status">
                Atención: Solo uno de los dos registros pudo ser obtenido completamente.
              </div>
            )}
            {data.status === 'complete' && (
              <div className="global-status-banner status-complete" role="status">
                Consulta finalizada correctamente.
              </div>
            )}

            <RcvTable
              title="Registro de Compras"
              type="compras"
              record={data.compras}
            />

            <RcvTable
              title="Registro de Ventas"
              type="ventas"
              record={data.ventas}
            />
          </div>
        )}
      </main>
    </div>
  );
}

export default App;

