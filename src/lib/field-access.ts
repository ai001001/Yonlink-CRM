/**
 * 当前用户的字段权限（前端显示用；服务端仍逐请求执行）：登录后随 /api/auth/me 读取。
 * - 隐藏：列表、详情、表单都不显示该字段（服务端也不返回其值）。
 * - 只读：显示，表单与就地编辑中不可修改。
 * The current user's field-level rules (UI only; the server enforces them on every request), loaded with
 * /api/auth/me. Hidden fields are not shown in lists, details or forms (the server does not return them either);
 * read-only fields are shown but cannot be edited.
 */
import type { MessageKey } from '@/i18n';

/** 对象 / entity */
export type FieldEntity = 'LEAD' | 'ACCOUNT' | 'CONTACT' | 'DEAL';
/** 访问级别 / access level */
export type FieldAccessLevel = 'HIDDEN' | 'READ_ONLY';
/** 规则：对象 → 字段（标准字段名或 custom.键）→ 访问级别 / rules: entity → field (name or custom.key) → access */
export type FieldAccessRules = Partial<Record<FieldEntity, Record<string, FieldAccessLevel>>>;

let store: FieldAccessRules = {};

/** 设置当前用户的规则 / set the current user's rules */
export function setFieldAccess(rules: FieldAccessRules | undefined): void {
  store = rules ?? {};
}

/** 字段是否对当前用户隐藏 / whether the field is hidden from the current user */
export const fieldHidden = (entity: FieldEntity, field: string): boolean => store[entity]?.[field] === 'HIDDEN';

/** 字段是否对当前用户只读 / whether the field is read-only for the current user */
export const fieldReadOnly = (entity: FieldEntity, field: string): boolean => store[entity]?.[field] === 'READ_ONLY';

/** 可限制的标准字段及名称（与服务端目录一致）/ restrictable standard fields and their labels (mirrors the server catalogue) */
export const STANDARD_FIELD_LABEL: Record<FieldEntity, Record<string, MessageKey>> = {
  LEAD: { title: 'leads.jobTitle', phone: 'leads.phone', mobile: 'leads.mobile', email: 'leads.email', description: 'common.description' },
  ACCOUNT: { phone: 'accounts.phone', website: 'accounts.website', address: 'accounts.address', description: 'common.description' },
  CONTACT: { title: 'contacts.title', phone: 'contacts.phone', email: 'contacts.email' },
  DEAL: { description: 'common.description' },
};
