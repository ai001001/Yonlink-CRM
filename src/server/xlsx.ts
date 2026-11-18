/**
 * 最小 Excel（.xlsx，Office Open XML）写入器：不依赖第三方库，使用 Node 自带的 zlib 压缩与 CRC32。
 * - 每个工作表一组行；单元格为文本、数字或带格式的数字（金额 #,##0.00、整数 #,##0、百分比 0.0"%"）。
 * - 文本以内联字符串写入（t="inlineStr"），不会被当作公式执行；XML 特殊字符转义，非法控制字符删除。
 * - 可设标题行与表头行（加粗）、冻结表头、列宽（按内容估算，中日韩字符按 2 个宽度计）。
 * Minimal .xlsx (Office Open XML) writer with no third-party library, using Node's zlib deflate and CRC32. One row list
 * per sheet; cells are text, numbers or formatted numbers (money #,##0.00, integer #,##0, percent 0.0"%"). Text is
 * written as inline strings so it is never evaluated as a formula; XML characters are escaped and invalid control
 * characters removed. Title and header rows can be bold, the header frozen, and column widths are estimated from the
 * content (CJK characters count double).
 */
import { crc32, deflateRawSync } from 'node:zlib';

/** 数字格式 / number format */
export type NumberFormat = 'money' | 'int' | 'percent';

/** 单元格 / cell */
export type Cell = string | number | null | undefined | { value: number | string | null; format?: NumberFormat; bold?: boolean };

/** 工作表 / sheet */
export interface Sheet {
  /** 工作表名（最多 31 个字符，不能含 \ / ? * [ ] :）/ sheet name (max 31 chars, no \ / ? * [ ] :) */
  name: string;
  rows: Cell[][];
  /** 加粗的行（从 0 开始）/ bold rows (0-based) */
  boldRows?: number[];
  /** 冻结前几行 / rows to freeze */
  freezeRows?: number;
}

// 样式编号与 styles.xml 中 cellXfs 的顺序一致 / style ids follow the cellXfs order in styles.xml
const STYLE = { text: 0, bold: 1, money: 2, int: 3, percent: 4, moneyBold: 5, intBold: 6, percentBold: 7 } as const;

/** XML 转义并删除 XML 1.0 不允许的控制字符 / escape XML and drop control characters XML 1.0 forbids */
function xml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 列号转字母（0 → A，26 → AA）/ column index to letters */
function colName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 文本显示宽度（中日韩及全角字符按 2 计）/ display width of text (CJK and full-width count double) */
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

/** 合法的工作表名（截断、替换非法字符、去重）/ a valid, unique sheet name */
function sheetName(name: string, used: Set<string>): string {
  const base = (name.replace(/[\\/?*[\]:]/g, ' ').trim() || 'Sheet').slice(0, 31);
  let out = base;
  for (let i = 2; used.has(out.toLowerCase()); i += 1) out = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
  used.add(out.toLowerCase());
  return out;
}

/** 一个单元格的 XML / XML of one cell */
function cellXml(ref: string, cell: Cell, boldRow: boolean): { xml: string; width: number } {
  if (cell === null || cell === undefined || cell === '') return { xml: '', width: 0 };
  const obj = typeof cell === 'object' ? cell : { value: cell };
  const bold = boldRow || obj.bold === true;
  if (obj.value === null || obj.value === '') return { xml: '', width: 0 };
  if (typeof obj.value === 'number' && Number.isFinite(obj.value)) {
    const fmt = obj.format;
    const style = fmt === 'money' ? (bold ? STYLE.moneyBold : STYLE.money) : fmt === 'int' ? (bold ? STYLE.intBold : STYLE.int) : fmt === 'percent' ? (bold ? STYLE.percentBold : STYLE.percent) : bold ? STYLE.bold : STYLE.text;
    const shown = fmt === 'money' ? obj.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(obj.value);
    return { xml: `<c r="${ref}" s="${style}"><v>${obj.value}</v></c>`, width: shown.length + (fmt === 'percent' ? 1 : 0) };
  }
  const text = String(obj.value);
  return { xml: `<c r="${ref}" t="inlineStr"${bold ? ` s="${STYLE.bold}"` : ''}><is><t xml:space="preserve">${xml(text)}</t></is></c>`, width: textWidth(text) };
}

/** 工作表 XML / worksheet XML */
function sheetXml(sheet: Sheet): string {
  const bold = new Set(sheet.boldRows ?? []);
  const widths: number[] = [];
  const rows = sheet.rows.map((row, r) => {
    const cells = row
      .map((cell, c) => {
        const out = cellXml(`${colName(c)}${r + 1}`, cell, bold.has(r));
        widths[c] = Math.max(widths[c] ?? 0, out.width);
        return out.xml;
      })
      .join('');
    return `<row r="${r + 1}">${cells}</row>`;
  });
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(8, (w ?? 0) + 2))}" customWidth="1"/>`).join('')}</cols>` : '';
  const freeze = sheet.freezeRows
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.freezeRows}" topLeftCell="A${sheet.freezeRows + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${cols}<sheetData>${rows.join('')}</sheetData></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0&quot;%&quot;"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="3" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/**
 * 把多个文件打包为 ZIP（DEFLATE 压缩，固定时间戳以便结果稳定）。
 * Pack files into a ZIP (DEFLATE, fixed timestamp for reproducible output).
 */
export function zip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  // 1980-01-01 00:00 的 DOS 日期时间 / DOS date-time of 1980-01-01 00:00
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名 / UTF-8 names
    local.writeUInt16LE(8, 8); // DEFLATE
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/**
 * 生成 .xlsx 文件内容。
 * Build the bytes of an .xlsx file.
 * @param sheets 工作表（至少一个）/ sheets (at least one)
 */
export function toXlsx(sheets: Sheet[]): Buffer {
  if (!sheets.length) throw new Error('At least one sheet is required');
  const used = new Set<string>();
  const names = sheets.map((s) => sheetName(s.name, used));
  const files = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: 'xl/styles.xml', data: STYLES },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];
  return zip(files.map((f) => ({ name: f.name, data: Buffer.from(f.data, 'utf8') })));
}

/** .xlsx 的 MIME 类型 / MIME type of .xlsx */
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
