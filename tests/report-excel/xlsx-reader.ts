/**
 * 测试用 .xlsx 读取器：按 ZIP 中央目录解出各文件（校验 CRC32），解析工作表单元格（引用、类型、样式、值）。
 * 与写入器分开实现，用于独立核对生成的文件。
 * Test-only .xlsx reader: unpacks files via the ZIP central directory (checking CRC32) and parses worksheet cells
 * (reference, type, style, value). Implemented separately from the writer to check generated files independently.
 */
import { crc32, inflateRawSync } from 'node:zlib';

/** 解出 ZIP 中的全部文件 / unpack every file of a ZIP */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('No end of central directory');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('Bad local header');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch in ${name}`);
    files.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** 单元格 / cell */
export interface ReadCell {
  ref: string;
  type: string | null;
  style: number;
  value: string;
}

/** XML 反转义 / unescape XML */
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/**
 * 读取工作簿：工作表名与各表单元格（按行）。
 * Read a workbook: sheet names and cells per sheet (by row).
 */
export function readXlsx(buf: Buffer) {
  const files = unzip(buf);
  const workbook = files.get('xl/workbook.xml')!.toString('utf8');
  const names = [...workbook.matchAll(/<sheet name="([^"]*)" sheetId="(\d+)"/g)].map((m) => unxml(m[1]!));
  const sheets = names.map((name, i) => {
    const sheetXml = files.get(`xl/worksheets/sheet${i + 1}.xml`)!.toString('utf8');
    const rows = [...sheetXml.matchAll(/<row r="(\d+)">(.*?)<\/row>/g)].map((m) => ({
      r: Number(m[1]),
      cells: [...m[2]!.matchAll(/<c r="([A-Z]+\d+)"(?: t="(\w+)")?(?: s="(\d+)")?>(?:<v>([^<]*)<\/v>|<is><t xml:space="preserve">([^<]*)<\/t><\/is>)<\/c>/g)].map(
        (c): ReadCell => ({ ref: c[1]!, type: c[2] ?? null, style: Number(c[3] ?? 0), value: unxml(c[4] ?? c[5] ?? '') }),
      ),
    }));
    /** 按行的值（文本或数字字符串），空单元格不出现 / values by row (text or number strings), empty cells omitted */
    const values = rows.map((r) => r.cells.map((c) => c.value));
    return { name, xml: sheetXml, rows, values };
  });
  return { files, names, sheets };
}
