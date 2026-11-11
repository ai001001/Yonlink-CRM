/**
 * 批量操作（参考 Zoho Mass Update / Mass Delete）：逐条调用单条记录的应用服务，
 * 因此权限、可见范围、业务规则与审计日志与单条操作完全一致；允许部分成功并逐条返回失败原因。
 * Bulk actions (cf. Zoho Mass Update / Mass Delete): each record goes through the single-record service,
 * so permissions, visibility, business rules and audit logs are identical; partial success is allowed
 * and every failure is reported with its reason.
 */
import { z } from 'zod';
import { DealStage, LeadStatus } from '@/generated/prisma/enums';
import type { AuthContext } from '../auth';
import type { ErrorCode } from '../errors';
import { toApiError } from '../http';
import { assertOwnerAssignable, requirePermission } from '../permissions';
import { resolveOwner } from '../validation';
import { deleteAccount, updateAccount } from './accounts';
import { deleteActivity, updateActivity } from './activities';
import { deleteDeal, updateDeal } from './deals';
import { deleteLead, updateLead } from './leads';

/** 单次最多处理的记录数 / Maximum records per request */
export const BULK_MAX = 200;

/** 记录 ID 列表（自动去重）/ Record ids (deduplicated) */
const ids = z
  .array(z.uuid())
  .min(1)
  .max(BULK_MAX)
  .transform((v) => [...new Set(v)]);

const assign = z.strictObject({ action: z.literal('assign'), ids, ownerId: z.uuid().nullable() });
const remove = z.strictObject({ action: z.literal('delete'), ids });

/** 线索批量操作 / Lead bulk actions */
export const leadBulkSchema = z.discriminatedUnion('action', [
  assign,
  z.strictObject({ action: z.literal('status'), ids, status: z.enum(LeadStatus).exclude([LeadStatus.CONVERTED]) }),
  remove,
]);
/** 客户批量操作 / Account bulk actions */
export const accountBulkSchema = z.discriminatedUnion('action', [assign, remove]);
/** 商机批量操作 / Deal bulk actions */
export const dealBulkSchema = z.discriminatedUnion('action', [assign, z.strictObject({ action: z.literal('stage'), ids, stage: z.enum(DealStage) }), remove]);
/** 跟进批量操作 / Activity bulk actions */
export const activityBulkSchema = z.discriminatedUnion('action', [assign, z.strictObject({ action: z.literal('complete'), ids, completed: z.boolean() }), remove]);

/** 批量结果 / Bulk result */
export interface BulkResult {
  succeeded: string[];
  failed: { id: string; code: ErrorCode; message: string }[];
}

/**
 * 逐条执行，收集成功与失败（每条记录独立事务，互不影响）。
 * Run per record and collect successes and failures (each record has its own transaction).
 */
async function runBulk(list: string[], fn: (id: string) => Promise<unknown>): Promise<BulkResult> {
  const result: BulkResult = { succeeded: [], failed: [] };
  for (const id of list) {
    try {
      await fn(id);
      result.succeeded.push(id);
    } catch (err) {
      const e = toApiError(err);
      result.failed.push({ id, code: e.code, message: e.message });
    }
  }
  return result;
}

/**
 * 整批前置检查：删除需删除权限；指派需能指派给该负责人且负责人属于本组织（失败则整批拒绝）。
 * Whole-batch checks: delete permission; assignability and owner validity (fail the whole request).
 */
async function precheck(ctx: AuthContext, input: { action: string; ownerId?: string | null }): Promise<void> {
  if (input.action === 'delete') requirePermission(ctx, 'record.delete');
  if (input.action === 'assign') {
    assertOwnerAssignable(ctx, input.ownerId ?? null);
    await resolveOwner(ctx.organizationId, input.ownerId ?? null, null);
  }
}

/** 线索批量操作 / Bulk actions on leads */
export async function bulkLeads(ctx: AuthContext, input: z.infer<typeof leadBulkSchema>): Promise<BulkResult> {
  await precheck(ctx, input);
  switch (input.action) {
    case 'assign':
      return runBulk(input.ids, (id) => updateLead(ctx, id, { ownerId: input.ownerId }));
    case 'status':
      return runBulk(input.ids, (id) => updateLead(ctx, id, { status: input.status }));
    case 'delete':
      return runBulk(input.ids, (id) => deleteLead(ctx, id));
  }
}

/** 客户批量操作 / Bulk actions on accounts */
export async function bulkAccounts(ctx: AuthContext, input: z.infer<typeof accountBulkSchema>): Promise<BulkResult> {
  await precheck(ctx, input);
  switch (input.action) {
    case 'assign':
      return runBulk(input.ids, (id) => updateAccount(ctx, id, { ownerId: input.ownerId }));
    case 'delete':
      return runBulk(input.ids, (id) => deleteAccount(ctx, id));
  }
}

/** 商机批量操作 / Bulk actions on deals */
export async function bulkDeals(ctx: AuthContext, input: z.infer<typeof dealBulkSchema>): Promise<BulkResult> {
  await precheck(ctx, input);
  switch (input.action) {
    case 'assign':
      return runBulk(input.ids, (id) => updateDeal(ctx, id, { ownerId: input.ownerId }));
    case 'stage':
      return runBulk(input.ids, (id) => updateDeal(ctx, id, { stage: input.stage }));
    case 'delete':
      return runBulk(input.ids, (id) => deleteDeal(ctx, id));
  }
}

/** 跟进批量操作 / Bulk actions on activities */
export async function bulkActivities(ctx: AuthContext, input: z.infer<typeof activityBulkSchema>): Promise<BulkResult> {
  await precheck(ctx, input);
  switch (input.action) {
    case 'assign':
      return runBulk(input.ids, (id) => updateActivity(ctx, id, { ownerId: input.ownerId }));
    case 'complete':
      return runBulk(input.ids, (id) => updateActivity(ctx, id, { completed: input.completed }));
    case 'delete':
      return runBulk(input.ids, (id) => deleteActivity(ctx, id));
  }
}
