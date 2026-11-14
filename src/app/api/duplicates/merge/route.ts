/**
 * POST /api/duplicates/merge — 合并重复记录（需删除权限）/ merge duplicates into a master record (delete permission).
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { mergeDuplicates, mergeSchema } from '@/server/modules/duplicates';

export const POST = authedRoute(async (req, ctx) => Response.json(await mergeDuplicates(ctx, await parseBody(req, mergeSchema))));
export const OPTIONS = preflight;
