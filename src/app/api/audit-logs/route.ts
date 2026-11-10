/**
 * GET /api/audit-logs — 审计日志查询（只读；不提供修改与删除接口）。
 * Audit log query (read-only; no update or delete endpoints exist).
 */
import { authedRoute, parseQuery, preflight } from '@/server/http';
import { auditListSchema, listAuditLogs } from '@/server/modules/audit-logs';

export const GET = authedRoute(async (req, ctx) => Response.json(await listAuditLogs(ctx, parseQuery(req, auditListSchema))));
export const OPTIONS = preflight;
