import { t } from '@/i18n';

/**
 * 咨询方式（唯一配置处）：QQ 号；联系人称呼默认取语言文件中的 contact.defaultName。
 * 可用环境变量 NEXT_PUBLIC_CONTACT_QQ、NEXT_PUBLIC_CONTACT_NAME 覆盖。
 * Contact details (single source): the QQ number; the contact name defaults to contact.defaultName in the
 * language files. Override with NEXT_PUBLIC_CONTACT_QQ / NEXT_PUBLIC_CONTACT_NAME.
 */
export const CONTACT_QQ = process.env.NEXT_PUBLIC_CONTACT_QQ || '3313395633';

/**
 * 联系人称呼（环境变量优先，否则按当前语言）。
 * Contact name (environment first, otherwise per the current language).
 */
export function contactName(): string {
  return process.env.NEXT_PUBLIC_CONTACT_NAME || t('contact.defaultName');
}

/**
 * 复制文本到剪贴板：优先使用 Clipboard API，不可用时退回隐藏文本框加 execCommand。
 * Copy text to the clipboard: Clipboard API first, falling back to a hidden textarea with execCommand.
 * @returns 是否成功 / whether it succeeded
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续尝试退回方案 / fall through to the fallback
  }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    el.remove();
    return ok;
  } catch {
    return false;
  }
}
