/**
 * GET/POST /api/blueprints/transitions — 记录当前可执行的转换（?entity=&id=）与执行转换。
 * Transitions available on a record now (?entity=&id=) and running one.
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { availableTransitions, blueprintRecordSchema, runTransition, transitionRunSchema } from '@/server/modules/blueprints';

export const GET = authedRoute(async (req, ctx) => {
  const q = parseQuery(req, blueprintRecordSchema);
  return Response.json(await availableTransitions(ctx, q.entity, q.id));
});
export const POST = authedRoute(async (req, ctx) => Response.json(await runTransition(ctx, await parseBody(req, transitionRunSchema))));
export const OPTIONS = preflight;
