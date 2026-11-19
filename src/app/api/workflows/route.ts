/**
 * GET/POST /api/workflows — 工作流规则列表（所有用户）与新建（需 workflow.manage）。
 * Workflow rules: list (everyone) and create (workflow.manage).
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { createWorkflow, listWorkflows, workflowCreateSchema, workflowListSchema } from '@/server/modules/workflows';

export const GET = authedRoute(async (req, ctx) => Response.json(await listWorkflows(ctx, parseQuery(req, workflowListSchema))));
export const POST = authedRoute(async (req, ctx) => Response.json(await createWorkflow(ctx, await parseBody(req, workflowCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
