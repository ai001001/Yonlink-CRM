/**
 * 区域相关的输入校验（只依赖 zod，供客户、商机等模块在加载时使用，避免循环引用）。
 * Territory input schemas (zod only, so accounts and deals can use them at load time without import cycles).
 */
import { z } from 'zod';

/** 客户上的区域：区域 ID、null（无区域）或 AUTO（自动）/ territory on an account: an id, null (none) or AUTO */
export const territoryInput = z.union([z.uuid(), z.null(), z.literal('AUTO')]).optional();
/** 列表筛选：区域 ID（含下级）、NONE（无区域）或 MINE（我负责或参与的区域）/ list filter: id (with descendants), NONE or MINE */
export const territoryFilter = z.union([z.uuid(), z.enum(['NONE', 'MINE'])]).optional();
