/**
 * GET/PATCH /api/profile — 我的个人信息、会话与登录记录；修改显示名称 / my profile, sessions and sign-ins; rename.
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { getProfile, profileUpdateSchema, updateProfile } from '@/server/modules/profile';

export const GET = authedRoute(async (_req, ctx) => Response.json(await getProfile(ctx)));
export const PATCH = authedRoute(async (req, ctx) => Response.json(await updateProfile(ctx, await parseBody(req, profileUpdateSchema))));
export const OPTIONS = preflight;
