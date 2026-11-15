/**
 * GET/PATCH/DELETE /api/campaigns/:id — 活动详情（统计与关联记录）、修改、删除（后两者需 campaign.manage）/
 * campaign detail (statistics and linked records), update and delete (campaign.manage).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { campaignUpdateSchema, deleteCampaign, getCampaign, updateCampaign } from '@/server/modules/campaigns';

export const GET = authedRoute(async (_req, ctx, route) => Response.json(await getCampaign(ctx, await routeId(route))));
export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateCampaign(ctx, await routeId(route), await parseBody(req, campaignUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteCampaign(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
