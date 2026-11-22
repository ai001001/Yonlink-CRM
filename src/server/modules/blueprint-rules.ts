/**
 * 流程蓝图的强制检查（线索、商机、工作流、查重合并使用）：启用蓝图后，线索状态或商机阶段只能通过蓝图转换修改。
 * 只依赖数据库与错误类型，避免循环引用；蓝图的维护与转换在 blueprints.ts。
 * Blueprint enforcement (used by leads, deals, workflows and merges): with an active blueprint, lead status or deal
 * stage changes only through blueprint transitions. Depends only on the database and errors to avoid import cycles;
 * maintenance and transitions live in blueprints.ts.
 */
import type { Prisma } from '@/generated/prisma/client';
import type { WorkflowEntity } from '@/generated/prisma/enums';
import { prisma } from '../db';
import { ApiError } from '../errors';

/** 蓝图控制的字段 / the field a blueprint controls */
export const BLUEPRINT_FIELD = { LEAD: 'status', DEAL: 'stage' } as const satisfies Record<WorkflowEntity, string>;

/**
 * 对象当前启用的蓝图（没有时为 null）。
 * The active blueprint of an entity (null when none).
 */
export function activeBlueprint(organizationId: string, entity: WorkflowEntity, client: Prisma.TransactionClient = prisma) {
  return client.blueprint.findFirst({ where: { organizationId, entity, isActive: true }, select: { id: true, name: true, transitions: true } });
}

/**
 * 有启用的蓝图时拒绝直接修改受控字段（409 BLUEPRINT_CONTROLLED）。
 * Refuse direct changes of the controlled field while a blueprint is active (409 BLUEPRINT_CONTROLLED).
 */
export async function assertNotControlled(organizationId: string, entity: WorkflowEntity, client: Prisma.TransactionClient = prisma): Promise<void> {
  if (await activeBlueprint(organizationId, entity, client)) {
    const field = BLUEPRINT_FIELD[entity];
    throw new ApiError(409, 'BLUEPRINT_CONTROLLED', `The ${field} is controlled by a blueprint`, { [field]: ['blueprint'] });
  }
}
