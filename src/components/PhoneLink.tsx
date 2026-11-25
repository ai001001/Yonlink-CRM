/**
 * 可点击的电话与邮箱：手机上点电话直接拨打、点邮箱打开邮件应用；空值不显示，无法识别的值只显示文本。
 * Clickable phone numbers and emails: tapping dials or opens the mail app on phones; empty values render nothing and
 * unrecognised values show as plain text.
 */
'use client';

import { mailHref, telHref } from '@/lib/phone';

/** 电话链接 / phone link */
export function PhoneLink({ value }: { value: string | null | undefined }) {
  const v = value?.trim();
  if (!v) return null;
  const href = telHref(v);
  if (!href) return <>{v}</>;
  return (
    <a href={href} data-testid="phone-link">
      {v}
    </a>
  );
}

/** 邮箱链接 / email link */
export function EmailLink({ value }: { value: string | null | undefined }) {
  const v = value?.trim();
  if (!v) return null;
  const href = mailHref(v);
  if (!href) return <>{v}</>;
  return (
    <a href={href} data-testid="email-link">
      {v}
    </a>
  );
}
