/**
 * GET /api/attachments/:id/download — 下载附件（需登录且所属记录可见；始终以附件方式下载，禁止内容嗅探与脚本执行）。
 * Download an attachment (sign-in and parent visibility required; always as a download, no sniffing or scripts).
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { contentDisposition, downloadAttachment } from '@/server/modules/attachments';

export const GET = authedRoute(async (_req, ctx, route) => {
  const file = await downloadAttachment(ctx, await routeId(route));
  return new Response(new Uint8Array(file.data), {
    headers: {
      'Content-Type': file.contentType,
      'Content-Length': String(file.data.byteLength),
      'Content-Disposition': contentDisposition(file.fileName),
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
});
export const OPTIONS = preflight;
