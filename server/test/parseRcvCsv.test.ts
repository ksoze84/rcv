import { describe, it, expect } from 'vitest';
import { parseRcvCsv } from '../src/infrastructure/csv/parseRcvCsv.js';
import { AppError } from '../src/domain/errors.js';

describe('parseRcvCsv', () => {
  it('parses basic semicolon delimited CSV successfully', () => {
    const csvContent = 'RUT;Razon Social;Monto\n76123456-7;Empresa SPA;150000';
    const bytes = new TextEncoder().encode(csvContent);

    const result = parseRcvCsv(bytes);

    expect(result.status).toBe('ok');
    expect(result.columns).toEqual(['RUT', 'Razon Social', 'Monto']);
    expect(result.rows).toEqual([['76123456-7', 'Empresa SPA', '150000']]);
  });

  it('parses comma delimited CSV successfully', () => {
    const csvContent = 'Folio,Tipo Doc,Total\n000123,33,5990\n000124,34,1200';
    const bytes = new TextEncoder().encode(csvContent);

    const result = parseRcvCsv(bytes);

    expect(result.status).toBe('ok');
    expect(result.columns).toEqual(['Folio', 'Tipo Doc', 'Total']);
    expect(result.rows).toEqual([
      ['000123', '33', '5990'],
      ['000124', '34', '1200'],
    ]);
  });

  it('handles UTF-8 BOM correctly and preserves Spanish accents', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const textBytes = new TextEncoder().encode('RUT;Razón Social;Descripción\n12345678-5;Compañía Eléctrica;Operación N° 1');
    const combined = new Uint8Array(bom.length + textBytes.length);
    combined.set(bom, 0);
    combined.set(textBytes, bom.length);

    const result = parseRcvCsv(combined);

    expect(result.status).toBe('ok');
    expect(result.columns).toEqual(['RUT', 'Razón Social', 'Descripción']);
    expect(result.rows).toEqual([['12345678-5', 'Compañía Eléctrica', 'Operación N° 1']]);
  });

  it('handles Windows-1252 encoded CSV when bytes are not valid UTF-8', () => {
    // Generar bytes Windows-1252 con caracteres acentuados
    // 'RUT;Razón;Ciudad\n1-9;Café;Valparaíso'
    const windowsAnsiBytes = new Uint8Array([
      // R U T ; R a z
      0x52, 0x55, 0x54, 0x3b, 0x52, 0x61, 0x7a,
      // ó (0xf3)
      0xf3,
      // n ; C i u d a d \n
      0x6e, 0x3b, 0x43, 0x69, 0x75, 0x64, 0x61, 0x64, 0x0a,
      // 1 - 9 ; C a f
      0x31, 0x2d, 0x39, 0x3b, 0x43, 0x61, 0x66,
      // é (0xe9)
      0xe9,
      // ; V a l p a r a
      0x3b, 0x56, 0x61, 0x6c, 0x70, 0x61, 0x72, 0x61,
      // í (0xed)
      0xed,
      // s o \n
      0x73, 0x6f, 0x0a,
    ]);

    const result = parseRcvCsv(windowsAnsiBytes);

    expect(result.status).toBe('ok');
    expect(result.columns).toEqual(['RUT', 'Razón', 'Ciudad']);
    expect(result.rows).toEqual([['1-9', 'Café', 'Valparaíso']]);
  });

  it('supports multiline fields, quotes escaping and CRLF/LF line breaks', () => {
    const csvContent = 'Codigo;Detalle;Observacion\r\n001;"Linea 1\r\nLinea 2";"Dijo ""Hola"""\r\n002;"Normal";""\n';
    const bytes = new TextEncoder().encode(csvContent);

    const result = parseRcvCsv(bytes);

    expect(result.status).toBe('ok');
    expect(result.columns).toEqual(['Codigo', 'Detalle', 'Observacion']);
    expect(result.rows).toEqual([
      ['001', 'Linea 1\r\nLinea 2', 'Dijo "Hola"'],
      ['002', 'Normal', ''],
    ]);
  });

  it('preserves leading zeros, formulas and does not cast numbers or dates', () => {
    const csvContent = 'Folio;Fecha;Monto;Formula\n00000452;2026-02-15;0150.00;=SUM(A1:B1)';
    const bytes = new TextEncoder().encode(csvContent);

    const result = parseRcvCsv(bytes);

    expect(result.rows[0]).toEqual(['00000452', '2026-02-15', '0150.00', '=SUM(A1:B1)']);
  });

  it('preserves duplicated column headers and order without mangling', () => {
    const csvContent = 'ID;Monto;Monto;Estado\n01;100;200;Emitida';
    const bytes = new TextEncoder().encode(csvContent);

    const result = parseRcvCsv(bytes);

    expect(result.columns).toEqual(['ID', 'Monto', 'Monto', 'Estado']);
    expect(result.rows).toEqual([['01', '100', '200', 'Emitida']]);
  });

  it('returns status empty when CSV has valid headers but no data rows', () => {
    const csvContent = 'RUT Emisor;Folio;Fecha Emision\n';
    const bytes = new TextEncoder().encode(csvContent);

    const result = parseRcvCsv(bytes);

    expect(result.status).toBe('empty');
    expect(result.columns).toEqual(['RUT Emisor', 'Folio', 'Fecha Emision']);
    expect(result.rows).toEqual([]);
  });

  it('returns status empty when CSV has valid comma-separated headers but no data rows', () => {
    const csvContent = 'RUT Emisor,Folio,Fecha Emision\r\n';
    const bytes = new TextEncoder().encode(csvContent);

    const result = parseRcvCsv(bytes);

    expect(result.status).toBe('empty');
    expect(result.columns).toEqual(['RUT Emisor', 'Folio', 'Fecha Emision']);
    expect(result.rows).toEqual([]);
  });

  it('returns status empty when headers have trailing blank lines and newlines without data rows', () => {
    const csvContent = 'RUT Emisor;Folio;Fecha Emision\r\n\n\r\n';
    const bytes = new TextEncoder().encode(csvContent);

    const result = parseRcvCsv(bytes);

    expect(result.status).toBe('empty');
    expect(result.rows).toEqual([]);
  });

  it('throws AppError CSV_EMPTY on empty bytes or whitespace-only content', () => {
    const emptyBytes = new Uint8Array(0);
    expect(() => parseRcvCsv(emptyBytes)).toThrow(AppError);
    try {
      parseRcvCsv(emptyBytes);
    } catch (err: unknown) {
      const appErr = err as AppError;
      expect(appErr.code).toBe('CSV_EMPTY');
      expect(appErr.httpStatus).toBe(400);
      expect(appErr.message).toBe('El archivo CSV está vacío.');
    }

    const whitespaceBytes = new TextEncoder().encode('   \r\n \n\t  ');
    expect(() => parseRcvCsv(whitespaceBytes)).toThrow(AppError);
    try {
      parseRcvCsv(whitespaceBytes);
    } catch (err: unknown) {
      const appErr = err as AppError;
      expect(appErr.code).toBe('CSV_EMPTY');
      expect(appErr.message).toBe('El archivo CSV está vacío.');
    }
  });

  it('throws AppError CSV_ZIP_RECEIVED for compressed files with PK signature', () => {
    const xlsxZipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    expect(() => parseRcvCsv(xlsxZipMagic)).toThrow(AppError);
    try {
      parseRcvCsv(xlsxZipMagic);
    } catch (err: unknown) {
      const appErr = err as AppError;
      expect(appErr.code).toBe('CSV_ZIP_RECEIVED');
      expect(appErr.httpStatus).toBe(400);
      expect(appErr.message).not.toContain('50');
      expect(appErr.message).toBe('El archivo recibido corresponde a un archivo comprimido (ZIP) y no a un CSV.');
    }

    const emptyZip = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0x00, 0x00]);
    expect(() => parseRcvCsv(emptyZip)).toThrow(AppError);
    try {
      parseRcvCsv(emptyZip);
    } catch (err: unknown) {
      const appErr = err as AppError;
      expect(appErr.code).toBe('CSV_ZIP_RECEIVED');
    }
  });

  it('throws AppError CSV_HTML_RECEIVED for HTML responses without leaking content', () => {
    const htmlResponse = '<!DOCTYPE html><html><body>Error de autenticacion secreto RUT 12345678-9</body></html>';
    const bytes = new TextEncoder().encode(htmlResponse);

    expect(() => parseRcvCsv(bytes)).toThrow(AppError);
    try {
      parseRcvCsv(bytes);
    } catch (err: unknown) {
      const appErr = err as AppError;
      expect(appErr.code).toBe('CSV_HTML_RECEIVED');
      expect(appErr.httpStatus).toBe(400);
      expect(appErr.message).not.toContain('12345678-9');
      expect(appErr.message).not.toContain('html');
      expect(appErr.message).toBe('La respuesta recibida corresponde a una página HTML y no a un archivo CSV.');
    }

    const htmlFragment = '<html lang="es"><head><title>SII</title></head><body>Sesion expirada</body></html>';
    try {
      parseRcvCsv(new TextEncoder().encode(htmlFragment));
    } catch (err: unknown) {
      expect((err as AppError).code).toBe('CSV_HTML_RECEIVED');
    }
  });

  it('throws AppError CSV_ENCODING_INVALID for undecodable byte sequences without leaking raw data', () => {
    // 0x81 es un byte no asignado en Windows-1252 y byte de continuación inválido en UTF-8
    const undecodableBytes = new Uint8Array([0x81, 0x81, 0x81, 0x81]);
    expect(() => parseRcvCsv(undecodableBytes)).toThrow(AppError);
    try {
      parseRcvCsv(undecodableBytes);
    } catch (err: unknown) {
      const appErr = err as AppError;
      expect(appErr.code).toBe('CSV_ENCODING_INVALID');
      expect(appErr.httpStatus).toBe(400);
      expect(appErr.message).toBe('El archivo recibido no pudo ser decodificado con una codificación de texto válida.');
    }
  });

  it('throws AppError CSV_STRUCTURE_INVALID for invalid delimiter, null bytes, JSON, and indeterminable structures', () => {
    // JSON response
    const jsonBytes = new TextEncoder().encode('{"error": "Session expired", "rut": "11111111-1"}');
    expect(() => parseRcvCsv(jsonBytes)).toThrow(AppError);
    try {
      parseRcvCsv(jsonBytes);
    } catch (err: unknown) {
      const appErr = err as AppError;
      expect(appErr.code).toBe('CSV_STRUCTURE_INVALID');
      expect(appErr.message).not.toContain('11111111-1');
    }

    // Caracteres nulos
    const nullBytes = new Uint8Array([0x52, 0x55, 0x54, 0x00, 0x3b, 0x4d]);
    expect(() => parseRcvCsv(nullBytes)).toThrow(AppError);
    try {
      parseRcvCsv(nullBytes);
    } catch (err: unknown) {
      expect((err as AppError).code).toBe('CSV_STRUCTURE_INVALID');
    }

    // Solo un campo sin delimitador
    const singleField = new TextEncoder().encode('SoloUnCampoSinDelimitador\n');
    expect(() => parseRcvCsv(singleField)).toThrow(AppError);
    try {
      parseRcvCsv(singleField);
    } catch (err: unknown) {
      expect((err as AppError).code).toBe('CSV_STRUCTURE_INVALID');
    }

    // Menos de 2 encabezados significativos
    const onlyOneSignificant = new TextEncoder().encode('   ;SoloUnHeader;\n1;2;3\n');
    expect(() => parseRcvCsv(onlyOneSignificant)).toThrow(AppError);
    try {
      parseRcvCsv(onlyOneSignificant);
    } catch (err: unknown) {
      expect((err as AppError).code).toBe('CSV_STRUCTURE_INVALID');
    }

    // Delimitador ambiguo
    const ambiguousText = new TextEncoder().encode('A,B;C\n1,2;3\n');
    expect(() => parseRcvCsv(ambiguousText)).toThrow(AppError);
    try {
      parseRcvCsv(ambiguousText);
    } catch (err: unknown) {
      expect((err as AppError).code).toBe('CSV_STRUCTURE_INVALID');
    }
  });

  it('throws AppError CSV_TOO_LARGE when bytes exceed maxCsvBytes', () => {
    const csvContent = 'RUT;Monto\n1-9;100';
    const bytes = new TextEncoder().encode(csvContent);

    expect(() => parseRcvCsv(bytes, { maxCsvBytes: 5 })).toThrow(AppError);
    try {
      parseRcvCsv(bytes, { maxCsvBytes: 5 });
    } catch (err: unknown) {
      const appErr = err as AppError;
      expect(appErr.code).toBe('CSV_TOO_LARGE');
      expect(appErr.message).toBe('El archivo CSV supera los límites permitidos.');
    }
  });

  it('throws AppError CSV_TOO_LARGE when rows exceed maxCsvRows without truncation', () => {
    const csvContent = 'RUT;Monto\n1-1;10\n1-2;20\n1-3;30';
    const bytes = new TextEncoder().encode(csvContent);

    expect(() => parseRcvCsv(bytes, { maxCsvRows: 2 })).toThrow(AppError);
    try {
      parseRcvCsv(bytes, { maxCsvRows: 2 });
    } catch (err: unknown) {
      const appErr = err as AppError;
      expect(appErr.code).toBe('CSV_TOO_LARGE');
      expect(appErr.message).toBe('El archivo CSV supera los límites permitidos.');
    }
  });

  it('preserves leading and trailing spaces inside cells without trimming', () => {
    const csvContent = ' ColA ; ColB \n  00123  ;  =SUM(A1)  \n';
    const bytes = new TextEncoder().encode(csvContent);

    const result = parseRcvCsv(bytes);

    expect(result.columns).toEqual([' ColA ', ' ColB ']);
    expect(result.rows).toEqual([['  00123  ', '  =SUM(A1)  ']]);
  });

  it('handles trailing empty values and empty lines cleanly', () => {
    const csvContent = 'Col1;Col2;Col3\nVal1;Val2;\n\n';
    const bytes = new TextEncoder().encode(csvContent);

    const result = parseRcvCsv(bytes);

    expect(result.status).toBe('ok');
    expect(result.columns).toEqual(['Col1', 'Col2', 'Col3']);
    expect(result.rows).toEqual([['Val1', 'Val2', '']]);
  });

  it('handles rows with extra trailing separators as seen in SII without throwing and creates synthetic headers', () => {
    // Simulación sintética del comportamiento del SII:
    // Encabezado de 9 columnas y filas con separadores vacíos extra al final (10 u 11 campos)
    const syntheticSiiCsv =
      'Nro;Tipo Doc;Tipo Compra;RUT Proveedor;Razon Social;Folio;Fecha Docto;Monto Total;Tasa Otro Impuesto\n' +
      '1;33;Del Giro;76000001-1;PROVEEDOR ALFA SPA;1001;01/02/2026;50000;;\n' +
      '2;61;Del Giro;76000002-2;PROVEEDOR BETA SPA;1002;02/02/2026;12500;;;\n';
    const bytes = new TextEncoder().encode(syntheticSiiCsv);

    const result = parseRcvCsv(bytes);

    expect(result.status).toBe('ok');
    expect(result.columns).toEqual([
      'Nro',
      'Tipo Doc',
      'Tipo Compra',
      'RUT Proveedor',
      'Razon Social',
      'Folio',
      'Fecha Docto',
      'Monto Total',
      'Tasa Otro Impuesto',
      'Columna 10',
      'Columna 11',
    ]);
    expect(result.rows).toHaveLength(2);
    // Fila 1 tiene 10 campos y se rellena con 1 vacío para igualar el ancho de 11 columnas
    expect(result.rows[0]).toEqual([
      '1',
      '33',
      'Del Giro',
      '76000001-1',
      'PROVEEDOR ALFA SPA',
      '1001',
      '01/02/2026',
      '50000',
      '',
      '',
      '',
    ]);
    // Fila 2 tiene 11 campos (los 9 normales + 2 separadores extra)
    expect(result.rows[1]).toEqual([
      '2',
      '61',
      'Del Giro',
      '76000002-2',
      'PROVEEDOR BETA SPA',
      '1002',
      '02/02/2026',
      '12500',
      '',
      '',
      '',
    ]);
  });

  it('pads rows with fewer fields with empty strings up to the table width', () => {
    const csvContent =
      'ColA;ColB;ColC;ColD\n' +
      '1;2;3;4\n' +
      '5;6\n' +
      '7\n';
    const bytes = new TextEncoder().encode(csvContent);

    const result = parseRcvCsv(bytes);

    expect(result.status).toBe('ok');
    expect(result.columns).toEqual(['ColA', 'ColB', 'ColC', 'ColD']);
    expect(result.rows).toEqual([
      ['1', '2', '3', '4'],
      ['5', '6', '', ''],
      ['7', '', '', ''],
    ]);
  });

  it('pads shorter rows when another row expands the table width beyond the header', () => {
    const csvContent =
      'ColA;ColB\n' +
      '1;2;3;4\n' +
      '5\n';
    const bytes = new TextEncoder().encode(csvContent);

    const result = parseRcvCsv(bytes);

    expect(result.status).toBe('ok');
    expect(result.columns).toEqual(['ColA', 'ColB', 'Columna 3', 'Columna 4']);
    expect(result.rows).toEqual([
      ['1', '2', '3', '4'],
      ['5', '', '', ''],
    ]);
  });

  it('preserves duplicate headers and maintains column alignment with irregular row counts', () => {
    const csvContent =
      'Monto;Monto;Detalle;Monto\n' +
      '100;200;Item 1\n' +
      '300;400;Item 2;500;600\n';
    const bytes = new TextEncoder().encode(csvContent);

    const result = parseRcvCsv(bytes);

    expect(result.status).toBe('ok');
    expect(result.columns).toEqual(['Monto', 'Monto', 'Detalle', 'Monto', 'Columna 5']);
    expect(result.rows).toEqual([
      ['100', '200', 'Item 1', '', ''],
      ['300', '400', 'Item 2', '500', '600'],
    ]);
  });

  it('handles Windows-1252 encoded CSV with Spanish accents and irregular column counts', () => {
    // Encabezado: 'Razón Social;Descripción;Monto\n'
    // Fila 1: 'Café del Sur;Operación N° 1;1500;;\n' (3 punto y comas -> 4 campos)
    // En Windows-1252:
    // ó: 0xF3, é: 0xE9, °: 0xB0
    const windows1252Bytes = new Uint8Array([
      // R a z ó n   S o c i a l ;
      0x52, 0x61, 0x7a, 0xf3, 0x6e, 0x20, 0x53, 0x6f, 0x63, 0x69, 0x61, 0x6c, 0x3b,
      // D e s c r i p c i ó n ;
      0x44, 0x65, 0x73, 0x63, 0x72, 0x69, 0x70, 0x63, 0x69, 0xf3, 0x6e, 0x3b,
      // M o n t o \n
      0x4d, 0x6f, 0x6e, 0x74, 0x6f, 0x0a,
      // C a f é   d e l   S u r ;
      0x43, 0x61, 0x66, 0xe9, 0x20, 0x64, 0x65, 0x6c, 0x20, 0x53, 0x75, 0x72, 0x3b,
      // O p e r a c i ó n   N °   1 ;
      0x4f, 0x70, 0x65, 0x72, 0x61, 0x63, 0x69, 0xf3, 0x6e, 0x20, 0x4e, 0xb0, 0x20, 0x31, 0x3b,
      // 1 5 0 0 ; ; \n
      0x31, 0x35, 0x30, 0x30, 0x3b, 0x3b, 0x0a,
    ]);

    const result = parseRcvCsv(windows1252Bytes);

    expect(result.status).toBe('ok');
    expect(result.columns).toEqual(['Razón Social', 'Descripción', 'Monto', 'Columna 4', 'Columna 5']);
    expect(result.rows).toEqual([
      ['Café del Sur', 'Operación N° 1', '1500', '', ''],
    ]);
  });

  it('handles semicolon delimited CSV with embedded quotes, line breaks, semicolons in cells and irregular columns', () => {
    const csvContent =
      'Codigo;Detalle;Observaciones\r\n' +
      '001;"Linea 1;\r\nLinea 2; con punto y coma";"Dijo ""Hola; Mundo"""\r\n' +
      '002;"Registro simple";"Sin notas";;\r\n';
    const bytes = new TextEncoder().encode(csvContent);

    const result = parseRcvCsv(bytes);

    expect(result.status).toBe('ok');
    expect(result.columns).toEqual(['Codigo', 'Detalle', 'Observaciones', 'Columna 4', 'Columna 5']);
    expect(result.rows).toEqual([
      ['001', 'Linea 1;\r\nLinea 2; con punto y coma', 'Dijo "Hola; Mundo"', '', ''],
      ['002', 'Registro simple', 'Sin notas', '', ''],
    ]);
  });

  it('parses the minimal reproduction sample with extra trailing delimiters successfully', () => {
    const sample =
      'Nro;Tipo Doc;Tipo Compra;RUT Proveedor;Razon Social;Folio;Fecha Docto;Monto Total;Tasa Otro Impuesto\n' +
      '1;33;Del Giro;76754296-8;EMPRESA SPA;1055815;05/02/2026;66363;;\n' +
      '2;61;Del Giro;96907830-9;Otra SpA;2689838;17/02/2026;15103;;\n';
    const bytes = new TextEncoder().encode(sample);

    const result = parseRcvCsv(bytes);

    expect(result.status).toBe('ok');
    expect(result.columns).toEqual([
      'Nro',
      'Tipo Doc',
      'Tipo Compra',
      'RUT Proveedor',
      'Razon Social',
      'Folio',
      'Fecha Docto',
      'Monto Total',
      'Tasa Otro Impuesto',
      'Columna 10',
    ]);
    expect(result.rows).toEqual([
      ['1', '33', 'Del Giro', '76754296-8', 'EMPRESA SPA', '1055815', '05/02/2026', '66363', '', ''],
      ['2', '61', 'Del Giro', '96907830-9', 'Otra SpA', '2689838', '17/02/2026', '15103', '', ''],
    ]);
  });
});
