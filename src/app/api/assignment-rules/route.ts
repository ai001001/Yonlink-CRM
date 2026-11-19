/**
 * GET/PUT /api/assignment-rules — 线索分配规则（查看：所有用户；保存：需 assignment.manage，整体替换）。
 * Lead assignment rules (read: everyone; save: assignment.manage, replaces all).
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { assignmentSaveSchema, getAssignmentRules, saveAssignmentRules } from '@/server/modules/assignment-rules';

export const GET = authedRoute(async (_req, ctx) => Response.json(await getAssignmentRules(ctx)));
export const PUT = authedRoute(async (req, ctx) => Response.json(await saveAssignmentRules(ctx, await parseBody(req, assignmentSaveSchema))));
export const OPTIONS = preflight;
