/**
 * GET/PATCH /api/portal-settings — 客户门户设置（需 portal.manage）。
 * Customer portal settings (portal.manage).
 */
import { authedRoute, parseBody, preflight } from '@/server/http';
import { getPortalSettings, portalSettingsSchema, updatePortalSettings } from '@/server/modules/portal';

export const GET = authedRoute(async (_req, ctx) => Response.json(await getPortalSettings(ctx)));
export const PATCH = authedRoute(async (req, ctx) => Response.json(await updatePortalSettings(ctx, await parseBody(req, portalSettingsSchema))));
export const OPTIONS = preflight;
