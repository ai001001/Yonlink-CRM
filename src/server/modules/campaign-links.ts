/**
 * 线索、商机关联市场活动时的校验（独立文件，避免与 deals、campaigns 模块循环引用）。
 * Validation when leads and deals link a campaign (separate file to avoid a cycle with the deals and campaigns modules).
 */
import { prisma } from '../db';
import { ApiError } from '../errors';

/**
 * 校验活动属于本组织；不存在时 400（客户端提交的活动 ID 不可信）。
 * Ensure a campaign belongs to the organization; 400 otherwise (client-supplied ids are never trusted).
 */
export async function assertCampaign(organizationId: string, campaignId: string | null | undefined): Promise<void> {
  if (!campaignId) return;
  if (!(await prisma.campaign.count({ where: { id: campaignId, organizationId } }))) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid campaign', { campaignId: ['not_found'] });
  }
}
