// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>();
  return {
    ...actual,
    useVirtualizer: (options: { count: number; estimateSize: () => number }) => {
      // Mock virtualizer que expone el primer y el último elemento de 20.000 filas
      const count = options.count;
      const size = options.estimateSize ? options.estimateSize() : 36;
      const totalSize = count * size;

      return {
        getVirtualItems: () => [
          { index: 0, start: 0, end: size, size, key: 0, lane: 0 },
          { index: count - 1, start: totalSize - size, end: totalSize, size, key: count - 1, lane: 0 },
        ],
        getTotalSize: () => totalSize,
        scrollToIndex: vi.fn(),
        scrollToOffset: vi.fn(),
      };
    },
  };
});

import { RcvTable } from '../src/components/RcvTable.js';

describe('RcvTable - MockVirtualizer Test (20.000 filas first y last)', () => {
  it('renderiza first y last rows en 20.000 filas con title, nowrap y aria-rowindex correctos', () => {
    const largeRows = Array.from({ length: 20000 }, (_, i) => [`FOLIO-${i + 1}`, `Cliente ${i + 1}`]);

    render(
      <RcvTable
        title="Registro de Ventas"
        type="ventas"
        record={{
          status: 'ok',
          columns: ['Folio', 'Cliente'],
          rows: largeRows,
        }}
      />
    );

    // Primera fila (index 0)
    const firstCell = screen.getByTitle('FOLIO-1');
    expect(firstCell).toBeInTheDocument();
    expect(firstCell).toHaveClass('rcv-table-cell');
    expect(screen.getByTitle('Cliente 1')).toBeInTheDocument();

    // Última fila (index 19999, 20.000 filas)
    const lastCell = screen.getByTitle('FOLIO-20000');
    expect(lastCell).toBeInTheDocument();
    expect(lastCell).toHaveClass('rcv-table-cell');
    expect(screen.getByTitle('Cliente 20000')).toBeInTheDocument();

    // Comprobar accesibilidad aria-rowcount en tabla y aria-rowindex en filas
    const table = screen.getByRole('table');
    expect(table).toHaveAttribute('aria-rowcount', '20001');
    expect(table).toHaveAttribute('aria-colcount', '2');

    const row0 = screen.getByRole('row', { name: /FOLIO-1 Cliente 1/i });
    expect(row0).toHaveAttribute('aria-rowindex', '2'); // 1-based, header es 1

    const row19999 = screen.getByRole('row', { name: /FOLIO-20000 Cliente 20000/i });
    expect(row19999).toHaveAttribute('aria-rowindex', '20001');
  });
});
