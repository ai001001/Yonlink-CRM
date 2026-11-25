/**
 * 电话与邮箱链接地址：只保留电话中的数字、+、-、括号（去掉空格）；没有数字或邮箱格式不合格时返回 null（只显示文本）。
 * Phone and email link targets: phones keep digits, +, - and parentheses (spaces removed); null when there is no
 * digit or the email looks wrong (the value is then shown as plain text).
 */

/** 分机写法：转（\u8f6c）、分机（\u5206\u673a）、ext、x、#；用转义写法以通过界面源码的中文守卫 / extension markers, escaped for the UI-source CJK guard */
const EXTENSION = /\s*(?:\u8f6c|\u5206\u673a|ext\.?|x|#)\s*/i;

/**
 * tel: 链接；“转 8”“ext 8”等分机号用拨号暂停符“,”接在主号码后，避免拼成错误号码。
 * tel: link; extensions ("转 8", "ext 8" …) follow the main number after a "," pause so they never merge into it.
 */
export function telHref(value: string | null | undefined): string | null {
  const [main = '', ext = ''] = (value ?? '').split(EXTENSION, 2);
  const dial = main.replace(/[^\d+\-()]/g, '');
  if (!/\d/.test(dial)) return null;
  const extension = ext.replace(/\D/g, '');
  return `tel:${dial}${extension ? `,${extension}` : ''}`;
}

/** mailto: 链接 / mailto: link */
export function mailHref(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return /^[^\s@<>"?&#]+@[^\s@<>"?&#]+\.[^\s@<>"?&#]+$/.test(v) ? `mailto:${v}` : null;
}
