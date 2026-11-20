/**
 * PATCH/DELETE /api/validation-rules/:id — 修改（含启停）与删除字段验证规则（需 validation.manage）。
 * Update (including toggling) and delete a validation rule (validation.manage).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deleteValidationRule, updateValidationRule, validationUpdateSchema } from '@/server/modules/validation-rules';

export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateValidationRule(ctx, await routeId(route), await parseBody(req, validationUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteValidationRule(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
