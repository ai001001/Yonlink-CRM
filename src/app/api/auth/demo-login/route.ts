/**
 * POST /api/auth/demo-login — 演示账号一键登录（仅演示环境开启）/ one-click demo login (demo environments only).
 */
import { z } from 'zod';
import { requestMeta } from '@/server/audit';
import { demoLogin, demoLoginEnabled } from '@/server/demo';
import { notFound } from '@/server/errors';
import { parseBody, preflight, publicRoute } from '@/server/http';

const body = z.strictObject({ userId: z.uuid() });

export const POST = publicRoute(async (req) => {
  // 未开启时一律 404，不暴露该功能的存在 / always 404 when disabled
  if (!demoLoginEnabled()) throw notFound();
  const { userId } = await parseBody(req, body);
  return Response.json(await demoLogin(userId, requestMeta(req)));
});
export const OPTIONS = preflight;
