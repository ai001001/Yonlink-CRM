/**
 * GET /api/portal/me — 门户首页信息（联系人、客户、组织、欢迎语）。
 * Portal home information (contact, account, organization, welcome text).
 */
import { preflight } from '@/server/http';
import { portalMe } from '@/server/modules/portal';
import { portalRoute } from '@/server/portal-auth';

export const GET = portalRoute(async (_req, ctx) => Response.json(await portalMe(ctx)));
export const OPTIONS = preflight;
