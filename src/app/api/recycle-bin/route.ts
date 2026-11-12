/**
 * GET/DELETE /api/recycle-bin — 回收站列表（需删除权限）与清空（需彻底删除权限）/ list (delete permission) and empty (purge permission).
 */
import { authedRoute, parseQuery, preflight } from '@/server/http';
import { emptyRecycleBin, listRecycleBin, recycleListSchema } from '@/server/modules/recycle-bin';

export const GET = authedRoute(async (req, ctx) => Response.json(await listRecycleBin(ctx, parseQuery(req, recycleListSchema))));
export const DELETE = authedRoute(async (_req, ctx) => Response.json(await emptyRecycleBin(ctx)));
export const OPTIONS = preflight;
