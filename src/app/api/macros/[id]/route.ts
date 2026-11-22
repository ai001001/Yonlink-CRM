/**
 * PATCH/DELETE /api/macros/:id — 修改与删除宏（个人宏仅创建人，共享宏需 macro.manage）。
 * Update and delete a macro (personal: creator only; shared: macro.manage).
 */
import { authedRoute, parseBody, preflight, routeId } from '@/server/http';
import { deleteMacro, macroUpdateSchema, updateMacro } from '@/server/modules/macros';

export const PATCH = authedRoute(async (req, ctx, route) => Response.json(await updateMacro(ctx, await routeId(route), await parseBody(req, macroUpdateSchema))));
export const DELETE = authedRoute(async (_req, ctx, route) => {
  await deleteMacro(ctx, await routeId(route));
  return new Response(null, { status: 204 });
});
export const OPTIONS = preflight;
