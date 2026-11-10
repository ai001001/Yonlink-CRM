/**
 * GET/POST /api/activities — 跟进记录列表与新建 / list and create activities.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { activityCreateSchema, activityListSchema, createActivity, listActivities } from '@/server/modules/activities';

export const GET = authedRoute(async (req, ctx) => Response.json(await listActivities(ctx, parseQuery(req, activityListSchema))));
export const POST = authedRoute(async (req, ctx) =>
  Response.json(await createActivity(ctx, await parseBody(req, activityCreateSchema)), { status: 201 }),
);
export const OPTIONS = preflight;
