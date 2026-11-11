/**
 * CSV 读写（RFC 4180）：支持引号、转义引号、字段内换行、CRLF 与 UTF-8 BOM；
 * 导出时防止公式注入（以 = + - @ 制表符 回车开头的单元格前加单引号）。
 * CSV read/write (RFC 4180): quotes, escaped quotes, embedded newlines, CRLF and UTF-8 BOM;
 * exports neutralise formula injection (cells starting with = + - @ tab or CR get a leading quote).
 */

/**
 * 解析 CSV 文本为二维数组（去除 BOM，忽略末尾空行）。
 * Parse CSV text into rows (BOM stripped, trailing empty lines ignored).
 * @throws Error 引号未闭合 / unterminated quote
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (inQuotes) throw new Error('Unterminated quoted field');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/** 可能被表格软件当作公式执行的开头字符 / leading characters spreadsheets may treat as formulas */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * 转义单个单元格：防公式注入，必要时加引号。
 * Escape one cell: neutralise formulas and quote when needed.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 生成 CSV（UTF-8 BOM + CRLF，便于 Excel 正确识别中文）。
 * Build CSV text (UTF-8 BOM + CRLF so Excel reads Chinese correctly).
 */
export function toCsv(header: string[], rows: unknown[][]): string {
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
