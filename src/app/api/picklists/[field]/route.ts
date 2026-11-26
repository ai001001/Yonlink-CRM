/**
 * PUT /api/picklists/:field — 整组替换某个标准下拉字段的选项（需 customfield.manage）；未知字段 404。
 * Replace the options of a standard picklist (customfield.manage); unknown fields are 404.
 */
import { notFound } from '@/server/errors';
import { authedRoute, parseBody, preflight } from '@/server/http';
import { picklistFieldSchema, picklistUpdateSchema, updatePicklist } from '@/server/modules/picklists';

export const PUT = authedRoute(async (req, ctx, route) => {
  const field = picklistFieldSchema.safeParse((await route.params).field);
  if (!field.success) throw notFound();
  return Response.json({ items: await updatePicklist(ctx, field.data, await parseBody(req, picklistUpdateSchema)) });
});
export const OPTIONS = preflight;
