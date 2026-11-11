/**
 * POST /api/accounts/import — CSV 导入（dryRun=true 时只预检不写入）/ CSV import (dry run validates only).
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { importCsv, importSchema } from '@/server/modules/import-export';

export const POST = authedRoute(async (req, ctx) => Response.json(await importCsv(ctx, 'accounts', await parseBody(req, importSchema))));
export const OPTIONS = preflight;
