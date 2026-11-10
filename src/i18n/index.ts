/**
 * 极简 i18n：按 key 取文案并替换 {变量}。
 * Minimal i18n: look up a message by key and interpolate {vars}.
 */
import { zhCN, type MessageKey } from './zh-CN';

export type { MessageKey };

const messages: Record<string, string> = zhCN;

/**
 * 翻译文案。
 * Translate a message key.
 * @param key 文案 key / message key
 * @param vars 插值变量 / interpolation variables
 * @returns 文案；缺失时返回 key / the message, or the key when missing
 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const text = messages[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? '')) : text;
}

/**
 * 翻译动态 key（如枚举值），缺失时回退为原值。
 * Translate a dynamic key (e.g. an enum value), falling back to the raw value.
 */
export function tEnum(prefix: string, value: string | null | undefined): string {
  if (!value) return '';
  return messages[`${prefix}.${value}`] ?? value;
}
