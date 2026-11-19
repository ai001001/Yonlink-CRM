/**
 * PATCH/DELETE /api/workflows/:id — 修改（含启停）与删除工作流规则（需 workflow.manage）。
 * Update (including toggling) and delete a workflow rule (workflow.manage).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deleteWorkflow, updateWorkflow, workflowUpdateSchema } from '@/server/modules/workflows';

export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateWorkflow(ctx, await routeId(route), await parseBody(req, workflowUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteWorkflow(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
