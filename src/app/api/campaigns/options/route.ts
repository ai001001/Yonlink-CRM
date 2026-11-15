/**
 * GET /api/campaigns/options — 供线索、商机选择的活动（不含已取消，可用 include 带上当前值）/ campaign options for
 * leads and deals (cancelled ones excluded unless passed as `include`).
 */
import { z } from 'zod';
import { authedRoute, parseQuery, preflight } from '@/server/http';
import { campaignOptions } from '@/server/modules/campaigns';

const query = z.strictObject({ include: z.uuid().optional() });

export const GET = authedRoute(async (req, ctx) => Response.json({ items: await campaignOptions(ctx, parseQuery(req, query).include) }));
export const OPTIONS = preflight;
