/**
 * 语言切换（中文 / English）：保存选择并刷新页面。
 * Language switch (中文 / English): persists the choice and reloads the page.
 */
'use client';

import { Segmented } from 'antd';
import { getLocale, LOCALES, setLocale, t, type Locale } from '@/i18n';

export function LanguageSwitch() {
  return (
    <Segmented<Locale>
      size="small"
      aria-label={t('lang.label')}
      data-testid="language-switch"
      value={getLocale()}
      onChange={(v) => v !== getLocale() && setLocale(v)}
      options={LOCALES.map((l) => ({ value: l, label: t(`lang.${l}`) }))}
    />
  );
}
