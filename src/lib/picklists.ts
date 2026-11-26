/**
 * 标准下拉字段的前端配置：登录后读取组织配置，设置自定义名称（所有 tEnum 显示随之生效），并提供按配置顺序的选项。
 * - 表单（新建、编辑、批量修改）只列启用的选项，编辑时保留记录当前的值；筛选与规则编辑列出全部选项（含已停用）。
 * - 未读取配置时使用内置选项。
 * Front-end picklist configuration: loaded after sign-in, it sets the custom labels (every tEnum display follows) and
 * provides options in the configured order. Forms list active options (keeping a record's current value); filters
 * and rule editors list every option, inactive included. Built-ins apply until the configuration is loaded.
 */
import { setEnumOverrides, tEnum } from '@/i18n';

/** 配置修改后通知外壳重新读取的事件名 / event telling the shell to reload the configuration */
export const PICKLISTS_CHANGED = 'yonlink:picklists-changed';

/** 字段 / field */
export type PicklistField = 'LEAD_SOURCE' | 'INDUSTRY' | 'LEAD_STATUS' | 'DEAL_STAGE' | 'ACTIVITY_TYPE';
/** 选项 / option */
export interface PicklistOption {
  value: string;
  label: string | null;
  isActive: boolean;
  isCustom: boolean;
  locked: boolean;
  probability: number | null;
}

/** i18n 枚举前缀对应的字段 / field behind each i18n enum prefix */
export const PREFIX_FIELD: Record<string, PicklistField> = { leadSource: 'LEAD_SOURCE', industry: 'INDUSTRY', leadStatus: 'LEAD_STATUS', dealStage: 'DEAL_STAGE', activityType: 'ACTIVITY_TYPE' };
/** 字段对应的 i18n 枚举前缀 / i18n enum prefix of each field */
export const FIELD_PREFIX: Record<PicklistField, string> = { LEAD_SOURCE: 'leadSource', INDUSTRY: 'industry', LEAD_STATUS: 'leadStatus', DEAL_STAGE: 'dealStage', ACTIVITY_TYPE: 'activityType' };

let store: Partial<Record<PicklistField, PicklistOption[]>> = {};

/**
 * 设置组织配置（同时设置自定义名称）。
 * Apply the organization's configuration (and its custom labels).
 */
export function setPicklists(fields: Partial<Record<PicklistField, PicklistOption[]>>): void {
  store = fields;
  const overrides: Record<string, Record<string, string>> = {};
  for (const [field, list] of Object.entries(fields) as [PicklistField, PicklistOption[]][]) {
    overrides[FIELD_PREFIX[field]] = Object.fromEntries(list.filter((o) => o.label).map((o) => [o.value, o.label!]));
  }
  setEnumOverrides(overrides);
}

/** 当前配置 / the current configuration */
export const picklistOf = (field: PicklistField): PicklistOption[] | undefined => store[field];

/**
 * 按配置顺序的选项值。
 * Option values in the configured order.
 * @param prefix i18n 枚举前缀 / i18n enum prefix
 * @param builtins 内置值（未配置时使用；也用于限定范围，如排除“已转化”）/ built-ins (used when unconfigured; also limits the range, e.g. without CONVERTED)
 * @param mode all 全部（筛选、规则）或 active 只含启用的（表单）/ all (filters, rules) or active only (forms)
 * @param keep 表单中记录当前的值（即使已停用也保留）/ a record's current value kept in forms even when inactive
 */
export function pickValues(prefix: string, builtins: readonly string[], mode: 'all' | 'active' = 'all', keep?: string | null): string[] {
  const field = PREFIX_FIELD[prefix];
  const list = field ? store[field] : undefined;
  if (!list) return [...builtins];
  // 可扩展字段包含自定义选项；其他字段限定在给定的内置值内 / extensible fields include custom options; others stay within the given built-ins
  const extensible = field === 'LEAD_SOURCE' || field === 'INDUSTRY';
  return list.filter((o) => (extensible || builtins.includes(o.value)) && (mode === 'all' || o.isActive || o.value === keep)).map((o) => o.value);
}

/**
 * 按配置顺序的下拉选项（值与显示名称）。
 * Select options in the configured order (value and label).
 */
export function pickOptions(prefix: string, builtins: readonly string[], mode: 'all' | 'active' = 'all', keep?: string | null): { value: string; label: string }[] {
  return pickValues(prefix, builtins, mode, keep).map((v) => ({ value: v, label: tEnum(prefix, v) }));
}
