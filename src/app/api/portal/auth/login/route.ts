/**
 * POST /api/portal/auth/login — 客户门户登录（门户标识 + 邮箱 + 密码），返回门户会话令牌。
 * Customer portal sign-in (portal key, email and password), returning a portal session token.
 */
import { parseBody, preflight, publicRoute } from '@/server/http';
import { requestMeta } from '@/server/audit';
import { portalLogin, portalLoginSchema } from '@/server/portal-auth';

export const POST = publicRoute(async (req) => Response.json(await portalLogin(await parseBody(req, portalLoginSchema), requestMeta(req))));
export const OPTIONS = preflight;
