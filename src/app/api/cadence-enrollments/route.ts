/**
 * GET /api/cadence-enrollments?entity=&id= — 记录参与的销售节奏（记录须可见）。
 * The cadences a record is enrolled in (the record must be visible).
 */
import { authedRoute, parseQuery, preflight } from '@/server/http';
import { enrollmentListSchema, listEnrollments } from '@/server/modules/cadences';

export const GET = authedRoute(async (req, ctx) => Response.json(await listEnrollments(ctx, parseQuery(req, enrollmentListSchema))));
export const OPTIONS = preflight;
