/**
 * 固定字典（不依赖任何业务模块，供各模块引用，避免循环依赖）。
 * Fixed dictionaries with no business-module imports, shared by modules to avoid import cycles.
 */

/** 线索来源（前端用 i18n 显示）/ Lead sources (displayed via i18n) */
export const LEAD_SOURCES = ['WEBSITE', 'REFERRAL', 'EXHIBITION', 'COLD_CALL', 'ADVERTISEMENT', 'SOCIAL_MEDIA', 'OTHER'] as const;

/** 支持的币种 / Supported currencies */
export const CURRENCIES = ['CNY', 'USD', 'EUR', 'HKD', 'JPY'] as const;

/** 行业字典 / Industry dictionary */
export const INDUSTRIES = [
  'MANUFACTURING',
  'IT',
  'FINANCE',
  'RETAIL',
  'EDUCATION',
  'HEALTHCARE',
  'CONSTRUCTION',
  'LOGISTICS',
  'GOVERNMENT',
  'OTHER',
] as const;

/** 宏、流程蓝图、销售节奏、验证规则支持的对象（工作流规则另外支持客户与服务工单）/ entities of macros, blueprints, cadences and validation rules (workflow rules also cover accounts and tickets) */
export const RECORD_ENTITIES = ['LEAD', 'DEAL'] as const;
export type RecordEntity = (typeof RECORD_ENTITIES)[number];
/** 读取的记录对象（数据库约束保证宏、蓝图、节奏、验证规则只存线索与商机）/ narrow a stored entity (database checks keep these tables to leads and deals) */
export const asRecordEntity = (entity: string) => entity as RecordEntity;
