/**
 * GET/POST /api/campaigns — 市场活动列表（附统计）与新建（需 campaign.manage）/ campaigns with statistics; create.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { campaignCreateSchema, campaignListSchema, createCampaign, listCampaigns } from '@/server/modules/campaigns';

export const GET = authedRoute(async (req, ctx) => Response.json(await listCampaigns(ctx, parseQuery(req, campaignListSchema))));
export const POST = authedRoute(async (req, ctx) => Response.json(await createCampaign(ctx, await parseBody(req, campaignCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
