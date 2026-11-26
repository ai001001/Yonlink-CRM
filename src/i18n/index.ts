/**
 * 极简 i18n：按 key 取文案并替换 {变量}；支持简体中文（默认）与英文。
 * - 浏览器端语言保存在 localStorage（yonlink-crm.locale），切换后刷新页面，使模块级常量（菜单、选项等）一并更新；
 * - 服务端（含预渲染）始终为默认语言；需要指定语言时（如导出 CSV）使用 translate / tEnumIn。
 * Minimal i18n: look up a message by key and interpolate {vars}; Simplified Chinese (default) and English.
 * The browser keeps the locale in localStorage and reloads after a switch so module-level constants refresh too;
 * the server (including prerendering) always uses the default; use translate / tEnumIn for an explicit locale.
 */
import { enUS } from './en-US';
import { zhCN, type MessageKey } from './zh-CN';

export type { MessageKey };

/** 支持的语言 / supported locales */
export const LOCALES = ['zh-CN', 'en-US'] as const;
export type Locale = (typeof LOCALES)[number];
/** 默认语言（中文优先）/ default locale (Chinese first) */
export const DEFAULT_LOCALE: Locale = 'zh-CN';
/** 浏览器存储键 / browser storage key */
export const LOCALE_STORAGE_KEY = 'yonlink-crm.locale';

const DICTS: Record<Locale, Record<string, string>> = { 'zh-CN': zhCN, 'en-US': enUS };

/** 是否为支持的语言 / whether a value is a supported locale */
export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

let browserLocale: Locale | null = null;

/**
 * 当前语言：浏览器读取 localStorage（读取一次后缓存），服务端始终为默认语言。
 * Current locale: the browser reads localStorage once and caches it; the server always uses the default.
 */
export function getLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  if (browserLocale) return browserLocale;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    // 存储不可用时使用默认语言 / storage unavailable: use the default
  }
  browserLocale = isLocale(stored) ? stored : DEFAULT_LOCALE;
  return browserLocale;
}

/**
 * 切换语言：保存并刷新页面。
 * Switch the locale: persist it and reload the page.
 */
export function setLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // 存储不可用时仅本次刷新生效不了，忽略 / ignore when storage is unavailable
  }
  window.location.reload();
}

/**
 * 按指定语言翻译。
 * Translate with an explicit locale.
 * @param locale 语言 / locale
 * @param key 文案 key / message key
 * @param vars 插值变量 / interpolation variables
 */
export function translate(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  const text = DICTS[locale][key] ?? DICTS[DEFAULT_LOCALE][key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? '')) : text;
}

/**
 * 翻译文案（当前语言）。
 * Translate a message key in the current locale.
 * @param key 文案 key / message key
 * @param vars 插值变量 / interpolation variables
 * @returns 文案；缺失时返回 key / the message, or the key when missing
 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(getLocale(), key, vars);
}

/**
 * 按指定语言翻译动态 key（如枚举值），缺失时回退为原值。
 * Translate a dynamic key (e.g. an enum value) in an explicit locale, falling back to the raw value.
 */
export function tEnumIn(locale: Locale, prefix: string, value: string | null | undefined): string {
  if (!value) return '';
  return enumOverrides[prefix]?.[value] ?? DICTS[locale][`${prefix}.${value}`] ?? DICTS[DEFAULT_LOCALE][`${prefix}.${value}`] ?? value;
}

/**
 * 内置的枚举名称（当前语言，不含组织自定义名称；用于设置页显示默认名称）。
 * The built-in enum label in the current locale, ignoring organization labels (shown as the default in setup).
 */
export function tEnumBuiltin(prefix: string, value: string): string {
  const locale = getLocale();
  return DICTS[locale][`${prefix}.${value}`] ?? DICTS[DEFAULT_LOCALE][`${prefix}.${value}`] ?? value;
}

/** 组织自定义的选项名称（只在浏览器中设置；服务端按请求传入名称，不使用这里）/ organization-defined option labels (browser only; the server passes labels per request instead) */
let enumOverrides: Record<string, Record<string, string>> = {};

/**
 * 设置组织自定义的选项名称（覆盖所有语言的内置名称）；传空对象清除。
 * Set organization-defined option labels (overriding the built-in labels in every locale); an empty object clears them.
 */
export function setEnumOverrides(overrides: Record<string, Record<string, string>>): void {
  enumOverrides = overrides;
}

/**
 * 翻译动态 key（当前语言）。
 * Translate a dynamic key in the current locale.
 */
export function tEnum(prefix: string, value: string | null | undefined): string {
  return tEnumIn(getLocale(), prefix, value);
}

/**
 * 全部语言中某个 key 的文案（导入时识别中英文列名与枚举名称）。
 * The message for a key in every locale (import accepts Chinese and English labels).
 */
export function allTranslations(key: string): string[] {
  return LOCALES.map((l) => DICTS[l][key]).filter((v): v is string => !!v);
}

/**
 * 某个枚举前缀下的全部代码（取自默认语言文案，如 leadSource → WEBSITE、REFERRAL…）。
 * All codes under an enum prefix, taken from the default messages (e.g. leadSource → WEBSITE, REFERRAL…).
 */
export function enumCodes(prefix: string): string[] {
  return Object.keys(DICTS[DEFAULT_LOCALE])
    .filter((k) => k.startsWith(`${prefix}.`))
    .map((k) => k.slice(prefix.length + 1));
}
