/**
 * POST /api/contacts/:id/portal/invite — 生成一次性门户邀请（开通、重新邀请或重设密码），令牌只返回这一次。
 * Create a one-time portal invitation (grant, re-invite or reset the password); the token is returned only now.
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { invitePortal } from '@/server/modules/portal';

export const POST = authedRoute(async (_req, ctx, route) => Response.json(await invitePortal(ctx, await routeId(route))));
export const OPTIONS = preflight;
