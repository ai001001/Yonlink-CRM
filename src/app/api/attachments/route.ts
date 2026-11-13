/**
 * GET/POST /api/attachments — 记录的附件列表与上传（multipart：file + leadId|accountId|dealId）。
 * List a record's attachments and upload one (multipart: file + leadId|accountId|dealId).
 */
import { ApiError } from '@/server/errors';
import { authedRoute, parseQuery, preflight } from '@/server/http';
import { attachmentParentSchema, listAttachments, MAX_FILE_BYTES, uploadAttachment } from '@/server/modules/attachments';

export const GET = authedRoute(async (req, ctx) => Response.json(await listAttachments(ctx, parseQuery(req, attachmentParentSchema))));

export const POST = authedRoute(async (req, ctx) => {
  // 先按 Content-Length 拒绝过大的请求，避免读入内存 / reject oversized bodies before reading them
  const length = Number(req.headers.get('content-length') ?? '0');
  if (length > MAX_FILE_BYTES + 64 * 1024) throw new ApiError(413, 'VALIDATION_ERROR', 'File too large', { file: ['too_large'] });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Expected multipart form data', { file: ['required'] });
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw new ApiError(400, 'VALIDATION_ERROR', 'File is required', { file: ['required'] });
  const fields = Object.fromEntries([...form.entries()].filter(([k]) => k !== 'file').map(([k, v]) => [k, String(v)]));
  const parsed = attachmentParentSchema.safeParse(fields);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid parent', { parent: ['invalid'] });
  const row = await uploadAttachment(ctx, parsed.data, { name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
  return Response.json(row, { status: 201 });
});
export const OPTIONS = preflight;
