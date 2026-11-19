/**
 * GET/PUT /api/approvals/settings — 报价单审批规则（查看：所有用户；保存：需 approval.manage）。
 * The quote approval policy (read: everyone; save: approval.manage).
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { approvalSettingsSchema, getApprovalSettings, saveApprovalSettings } from '@/server/modules/approvals';

export const GET = authedRoute(async (_req, ctx) => Response.json(await getApprovalSettings(ctx)));
export const PUT = authedRoute(async (req, ctx) => Response.json(await saveApprovalSettings(ctx, await parseBody(req, approvalSettingsSchema))));
export const OPTIONS = preflight;
