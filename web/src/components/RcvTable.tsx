import React, { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { RcvRecord } from '../../../shared/rcv.js';

export interface RcvTableProps {
  title: string;
  type: 'compras' | 'ventas';
  record: RcvRecord;
}

const ROW_HEIGHT = 36;
const VIRTUALIZATION_THRESHOLD = 100;

export function RcvTableComponent({
  title,
  type,
  record,
}: RcvTableProps): React.JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null);

  const rows = record.status === 'ok' ? record.rows : [];
  const shouldVirtualize = rows.length > VIRTUALIZATION_THRESHOLD;

  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? rows.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 25,
  });

  const virtualItems = shouldVirtualize ? rowVirtualizer.getVirtualItems() : [];
  const totalSize = shouldVirtualize ? rowVirtualizer.getTotalSize() : 0;
  const paddingTop = virtualItems.length > 0 ? (virtualItems[0]?.start ?? 0) : 0;
  const paddingBottom = virtualItems.length > 0
    ? totalSize - (virtualItems[virtualItems.length - 1]?.end ?? 0)
    : 0;

  const getStatusBadge = () => {
    switch (record.status) {
      case 'ok':
        return (
          <span className="badge badge-success" data-testid={`status-${type}`}>
            {record.rows.length} registros
          </span>
        );
      case 'empty':
        return (
          <span className="badge badge-neutral" data-testid={`status-${type}`}>
            Sin movimientos
          </span>
        );
      case 'error':
        return (
          <span className="badge badge-error" data-testid={`status-${type}`}>
            Error al consultar
          </span>
        );
    }
  };

  return (
    <section className="rcv-table-section" aria-labelledby={`title-${type}`}>
      <div className="rcv-table-header">
        <div className="header-info">
          <h2 id={`title-${type}`} className="table-title">
            {title}
          </h2>
          <span className="table-type-tag">({type})</span>
        </div>
        <div className="header-status">{getStatusBadge()}</div>
      </div>

      {record.status === 'error' && (
        <div className="table-error-container" role="alert">
          <p className="table-error-title">No fue posible obtener este registro.</p>
          <p className="table-error-message">{record.error.message}</p>
        </div>
      )}

      {record.status === 'empty' && (
        <div className="table-empty-container" data-testid={`empty-${type}`}>
          <p className="table-empty-title">Sin movimientos para el período</p>
          <p className="table-empty-message">No se registran documentos en el período consultado.</p>
        </div>
      )}

      {record.status === 'ok' && (
        <div
          ref={parentRef}
          className="table-scroll-container"
          tabIndex={0}
          role="region"
          aria-label={`Tabla de ${title}`}
        >
          <table
            className="rcv-data-table"
            aria-rowcount={record.rows.length + 1}
            aria-colcount={record.columns.length}
          >
            <thead>
              <tr role="row" aria-rowindex={1}>
                {record.columns.map((col, index) => (
                  // Usamos key compuesta por index para manejar nombres de columna duplicados
                  <th key={`col-${index}-${col}`} scope="col">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            {shouldVirtualize ? (
              <tbody>
                {paddingTop > 0 && (
                  <tr style={{ height: `${paddingTop}px`, border: 'none' }} aria-hidden="true">
                    <td
                      colSpan={Math.max(record.columns.length, 1)}
                      style={{ height: `${paddingTop}px`, padding: 0, border: 'none' }}
                    />
                  </tr>
                )}
                {virtualItems.map((virtualRow) => {
                  const row = rows[virtualRow.index];
                  if (!row) return null;
                  return (
                    <tr
                      key={`row-${virtualRow.index}`}
                      role="row"
                      aria-rowindex={virtualRow.index + 2}
                      data-index={virtualRow.index}
                      style={{ height: `${ROW_HEIGHT}px` }}
                    >
                      {row.map((cellValue, cellIndex) => (
                        <td
                          key={`cell-${virtualRow.index}-${cellIndex}`}
                          title={cellValue}
                          className="rcv-table-cell"
                        >
                          {cellValue}
                        </td>
                      ))}
                    </tr>
                  );
                })}
                {paddingBottom > 0 && (
                  <tr style={{ height: `${paddingBottom}px`, border: 'none' }} aria-hidden="true">
                    <td
                      colSpan={Math.max(record.columns.length, 1)}
                      style={{ height: `${paddingBottom}px`, padding: 0, border: 'none' }}
                    />
                  </tr>
                )}
              </tbody>
            ) : (
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr
                    key={`row-${rowIndex}`}
                    role="row"
                    aria-rowindex={rowIndex + 2}
                  >
                    {row.map((cellValue, cellIndex) => (
                      <td
                        key={`cell-${rowIndex}-${cellIndex}`}
                        title={cellValue}
                        className="rcv-table-cell"
                      >
                        {cellValue}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      )}
    </section>
  );
}

export { RcvTableComponent as RcvTable };
