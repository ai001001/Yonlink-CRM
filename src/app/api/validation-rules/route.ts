/**
 * GET/POST /api/validation-rules — 字段验证规则列表（所有用户）与新建（需 validation.manage）。
 * Validation rules: list (everyone) and create (validation.manage).
 */
import { authedRoute, parseBody, parseQuery, preflight } from '@/server/http';
import { createValidationRule, listValidationRules, validationCreateSchema, validationListSchema } from '@/server/modules/validation-rules';

export const GET = authedRoute(async (req, ctx) => Response.json(await listValidationRules(ctx, parseQuery(req, validationListSchema))));
export const POST = authedRoute(async (req, ctx) => Response.json(await createValidationRule(ctx, await parseBody(req, validationCreateSchema)), { status: 201 }));
export const OPTIONS = preflight;
