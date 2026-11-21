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
