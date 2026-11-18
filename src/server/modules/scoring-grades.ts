/**
 * 评分分级（线索、客户、联系人共用）：阈值读取、分级与分级筛选条件、列表的评分查询参数。
 * 本模块不依赖各业务模块，避免循环引用。
 * Score grades shared by leads, accounts and contacts: thresholds, grading, grade filters and the list query fields.
 * This module depends on no business module, so there are no import cycles.
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { ScoringEntity } from '@/generated/prisma/enums';
import { prisma } from '../db';

/** 分级 / grade */
export type ScoreGrade = 'hot' | 'warm' | 'cold';

/** 评分阈值的默认值（组织未设置时使用）/ default thresholds when an organization has none */
export const DEFAULT_SCORE_THRESHOLDS = { hotScore: 60, warmScore: 30 } as const;

/** 列表的评分查询参数：分级筛选与按评分排序 / list query fields: grade filter and score sort */
export const scoreListFields = {
  /** 评分分级 / score grade */
  grade: z.enum(['hot', 'warm', 'cold']).optional(),
  /** 排序：默认按创建时间倒序，score 为按评分从高到低 / sort: newest first by default, score = highest score first */
  sort: z.enum(['score']).optional(),
};

/**
 * 读取组织某类对象的评分阈值。
 * Read an organization's thresholds for an entity.
 */
export async function scoreThresholds(organizationId: string, entity: ScoringEntity): Promise<{ hotScore: number; warmScore: number }> {
  const s = await prisma.scoringSettings.findUnique({ where: { organizationId_entity: { organizationId, entity } }, select: { hotScore: true, warmScore: true } });
  return s ?? { ...DEFAULT_SCORE_THRESHOLDS };
}

/**
 * 分级对应的分数区间：热门 ≥ 热门阈值；温和在两个阈值之间；冷淡 < 温和阈值。
 * The score range of a grade: hot >= hot threshold; warm between the thresholds; cold below the warm threshold.
 */
export async function gradeRange(organizationId: string, entity: ScoringEntity, grade: ScoreGrade | undefined): Promise<Prisma.IntFilter | undefined> {
  if (!grade) return undefined;
  const t = await scoreThresholds(organizationId, entity);
  if (grade === 'hot') return { gte: t.hotScore };
  if (grade === 'warm') return { gte: t.warmScore, lt: t.hotScore };
  return { lt: t.warmScore };
}

/**
 * 按阈值分级。
 * Grade a score by the thresholds.
 */
export function gradeOf(score: number, t: { hotScore: number; warmScore: number }): ScoreGrade {
  return score >= t.hotScore ? 'hot' : score >= t.warmScore ? 'warm' : 'cold';
}

/** 按评分排序的 orderBy / orderBy for the score sort */
export function scoreOrder<T>(sort: 'score' | undefined, fallback: T[]): ({ score: 'desc' } | T)[] {
  return sort === 'score' ? [{ score: 'desc' }, ...fallback] : fallback;
}
