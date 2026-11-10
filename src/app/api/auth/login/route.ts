/**
 * POST /api/auth/login — 邮箱密码登录 / sign in with email and password.
 */
import { z } from 'zod';
import { login } from '@/server/auth';
import { parseBody, preflight, publicRoute } from '@/server/http';

const body = z.object({ email: z.email().max(254), password: z.string().min(1).max(200) });

export const POST = publicRoute(async (req) => {
  const { email, password } = await parseBody(req, body);
  return Response.json(await login(email, password));
});
export const OPTIONS = preflight;
