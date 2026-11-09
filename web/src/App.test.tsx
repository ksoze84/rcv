// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { App } from './App.js';

describe('App Component', () => {
  it('renderiza el titulo y el badge del periodo febrero 2026', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Registro de compras y ventas'
    );
    expect(screen.getByText('Febrero de 2026')).toBeInTheDocument();
  });
});
