import { describe, it, expect } from 'vitest';
import {
  RCV_PERIOD,
  normalizeRut,
  isValidRut,
  credentialsSchema,
} from './rcv.js';

describe('RCV_PERIOD', () => {
  it('fija el periodo en febrero de 2026', () => {
    expect(RCV_PERIOD).toEqual({ year: 2026, month: 2 });
  });
});

describe('normalizeRut', () => {
  it('elimina puntos, guiones y espacios, colocando guion antes del digito verificador en mayuscula', () => {
    expect(normalizeRut(' 12.345.678-k ')).toBe('12345678-K');
    expect(normalizeRut('111111111')).toBe('11111111-1');
    expect(normalizeRut('9.876.543-2')).toBe('9876543-2');
  });

  it('maneja strings cortas o vacias', () => {
    expect(normalizeRut('')).toBe('');
    expect(normalizeRut('K')).toBe('K');
  });
});

describe('isValidRut', () => {
  it('valida RUTs con DV correcto (numeros y K)', () => {
    expect(isValidRut('11.111.111-1')).toBe(true);
    expect(isValidRut('12.345.678-5')).toBe(true);
    // RUT con DV K valido: 10.000.013-K
    expect(isValidRut('10000013-K')).toBe(true);
    expect(isValidRut('10.000.013-k')).toBe(true);
  });

  it('rechaza RUTs con DV erroneo', () => {
    expect(isValidRut('11.111.111-2')).toBe(false);
    expect(isValidRut('12.345.678-0')).toBe(false);
    expect(isValidRut('invalid-rut')).toBe(false);
  });
});

describe('credentialsSchema', () => {
  it('acepta credenciales validas para tributaria y clave-unica sin modificar password', () => {
    const raw = {
      rut: ' 11.111.111-1 ',
      password: '  mypassword  ',
      authMode: 'tributaria',
    };
    const parsed = credentialsSchema.parse(raw);
    expect(parsed.rut).toBe('11111111-1');
    // Password SIN trim
    expect(parsed.password).toBe('  mypassword  ');
    expect(parsed.authMode).toBe('tributaria');
  });

  it('rechaza claves vacias y campos adicionales (strict)', () => {
    expect(() =>
      credentialsSchema.parse({
        rut: '11.111.111-1',
        password: '',
        authMode: 'clave-unica',
      })
    ).toThrow();

    expect(() =>
      credentialsSchema.parse({
        rut: '11.111.111-1',
        password: 'valid',
        authMode: 'clave-unica',
        extraField: 'not-allowed',
      })
    ).toThrow();
  });
});
