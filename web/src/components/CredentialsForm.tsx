import React, { useState } from 'react';
import { Download } from 'lucide-react';
import {
  credentialsSchema,
  normalizeRut,
  type AuthMode,
  type Credentials,
} from '../../../shared/rcv.js';

export interface CredentialsFormProps {
  onSubmit: (credentials: Credentials) => void;
  isLoading: boolean;
  isDisabled?: boolean;
}

export function CredentialsForm({
  onSubmit,
  isLoading,
  isDisabled = false,
}: CredentialsFormProps): React.JSX.Element {
  const [rut, setRut] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState<AuthMode>('tributaria');
  const [rutError, setRutError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const handleRutChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setRut(e.target.value);
    if (rutError) setRutError(null);
  };

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // La contraseña nunca se recorta ni modifica
    setPassword(e.target.value);
    if (passwordError) setPasswordError(null);
  };

  const handleModeChange = (mode: AuthMode) => {
    setAuthMode(mode);
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (isLoading || isDisabled) {
      return;
    }

    setRutError(null);
    setPasswordError(null);

    // Validar con el esquema estricto de credenciales
    const validationResult = credentialsSchema.safeParse({
      rut,
      password,
      authMode,
    });

    if (!validationResult.success) {
      const fieldErrors = validationResult.error.flatten().fieldErrors;
      if (fieldErrors.rut && fieldErrors.rut[0]) {
        setRutError(fieldErrors.rut[0]);
      }
      if (fieldErrors.password && fieldErrors.password[0]) {
        setPasswordError(fieldErrors.password[0]);
      }
      return;
    }

    const validCredentials = validationResult.data;

    // Actualizar visualmente el RUT con el formato normalizado para claridad
    setRut(validCredentials.rut);

    // Capturar las credenciales para la llamada y VACIAR inmediatamente la contraseña local
    setPassword('');

    // Emitir hacia el orquestador
    onSubmit(validCredentials);
  };

  const isFormBlocked = isLoading || isDisabled;

  return (
    <form onSubmit={handleSubmit} noValidate className="credentials-form" aria-label="Formulario de consulta RCV">
      <fieldset className="form-group-radios" disabled={isFormBlocked}>
        <legend className="form-label">Tipo de autenticación</legend>
        <div className="radio-group">
          <label className="radio-label">
            <input
              type="radio"
              name="authMode"
              value="tributaria"
              checked={authMode === 'tributaria'}
              onChange={() => handleModeChange('tributaria')}
              disabled={isFormBlocked}
            />
            <span>Clave Tributaria</span>
          </label>
          <label className="radio-label">
            <input
              type="radio"
              name="authMode"
              value="clave-unica"
              checked={authMode === 'clave-unica'}
              onChange={() => handleModeChange('clave-unica')}
              disabled={isFormBlocked}
            />
            <span>Clave Única</span>
          </label>
        </div>
      </fieldset>

      <div className="form-group">
        <label htmlFor="rut-input" className="form-label">
          RUT
        </label>
        <input
          id="rut-input"
          name="rut"
          type="text"
          value={rut}
          onChange={handleRutChange}
          onBlur={() => {
            if (rut) {
              setRut(normalizeRut(rut));
            }
          }}
          disabled={isFormBlocked}
          placeholder="12345678-5"
          autoComplete="username"
          className={`input-text ${rutError ? 'input-error' : ''}`}
          aria-invalid={!!rutError}
          aria-describedby={rutError ? 'rut-error-msg' : undefined}
          required
        />
        {rutError && (
          <span id="rut-error-msg" className="error-text" role="alert">
            {rutError}
          </span>
        )}
      </div>

      <div className="form-group">
        <label htmlFor="password-input" className="form-label">
          Contraseña
        </label>
        <input
          id="password-input"
          name="password"
          type="password"
          value={password}
          onChange={handlePasswordChange}
          disabled={isFormBlocked}
          autoComplete="current-password"
          className={`input-text ${passwordError ? 'input-error' : ''}`}
          aria-invalid={!!passwordError}
          aria-describedby={passwordError ? 'password-error-msg' : undefined}
          required
        />
        {passwordError && (
          <span id="password-error-msg" className="error-text" role="alert">
            {passwordError}
          </span>
        )}
      </div>

      <div className="form-actions">
        <button
          type="submit"
          disabled={isFormBlocked}
          className="btn-primary"
        >
          <Download size={18} aria-hidden="true" />
          <span>{isLoading ? 'Obteniendo registro...' : 'Obtener registro'}</span>
        </button>
      </div>
    </form>
  );
}
