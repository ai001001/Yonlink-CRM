/**
 * POST /api/recycle-bin/:id/restore — 恢复回收站条目（需删除权限）/ restore an entry (delete permission).
 */
import { authedRoute, preflight, routeId } from '@/server/http';
import { restoreItem } from '@/server/modules/recycle-bin';

export const POST = authedRoute(async (_req, ctx, route) => Response.json(await restoreItem(ctx, await routeId(route))));
export const OPTIONS = preflight;
