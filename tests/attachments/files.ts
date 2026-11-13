/**
 * 附件测试辅助：multipart 上传与二进制下载（tests/helpers 的 call 只处理 JSON）。
 * Attachment test helpers: multipart upload and binary download (the shared `call` helper handles JSON only).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as attachments from '@/app/api/attachments/route';
import * as download from '@/app/api/attachments/[id]/download/route';

const route = { params: Promise.resolve({}) };

/** 上传 / upload */
export async function upload(token: string | undefined, parent: Record<string, string>, name: string, bytes: Uint8Array | string, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.append('file', new File([(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes) as BlobPart], name));
  for (const [k, v] of Object.entries({ ...parent, ...extra })) form.append(k, v);
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const res = await attachments.POST(new Request('http://localhost/api/attachments', { method: 'POST', headers, body: form }), route);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** 下载 / download */
export async function fetchFile(token: string | undefined, id: string) {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const res = await download.GET(new Request(`http://localhost/api/attachments/${id}/download`, { headers }), { params: Promise.resolve({ id }) });
  return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
}

/** 磁盘上的文件 / file on disk */
export const diskPath = (orgId: string, id: string) => join(process.env.ATTACHMENTS_DIR!, orgId, id);
export const onDisk = (orgId: string, id: string) => existsSync(diskPath(orgId, id));
export const readDisk = (orgId: string, id: string) => readFileSync(diskPath(orgId, id));

/** 常见文件头 / common file signatures */
export const SAMPLES = {
  pdf: new TextEncoder().encode('%PDF-1.4\n%演示\n'),
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  docx: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0]),
  xls: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]),
  jpg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]),
};
