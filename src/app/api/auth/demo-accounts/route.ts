/**
 * GET /api/auth/demo-accounts — 演示账号列表（仅演示环境开启）/ demo accounts (demo environments only).
 */
import { preflight, publicRoute } from '@/server/http';
import { listDemoAccounts } from '@/server/demo';

export const GET = publicRoute(async () => Response.json({ items: await listDemoAccounts() }));
export const OPTIONS = preflight;
