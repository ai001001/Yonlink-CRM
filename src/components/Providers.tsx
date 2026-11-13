/**
 * 全局 Provider：主题、语言包（中文 / 英文，随当前语言）、登录状态。
 * Global providers: theme, locale packs (Chinese / English, following the current locale) and auth state.
 */
'use client';

import { useEffect, type ReactNode } from 'react';
import { App as AntApp, ConfigProvider } from 'antd';
import en from 'antd/locale/en_US';
import zh from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/en';
import 'dayjs/locale/zh-cn';
import { getLocale, t } from '@/i18n';
import { AuthProvider } from './AuthProvider';

const locale = getLocale();
dayjs.locale(locale === 'en-US' ? 'en' : 'zh-cn');

export function Providers({ children }: { children: ReactNode }) {
  useEffect(() => {
    // 页面语言与标题跟随当前语言 / document language and title follow the current locale
    document.documentElement.lang = locale;
    document.title = `${t('app.name')} | ${t('app.brand')}`;
  }, []);
  return (
    <ConfigProvider locale={locale === 'en-US' ? en : zh} theme={{ token: { colorPrimary: '#1f5fbf', borderRadius: 6 } }}>
      <AntApp>
        <AuthProvider>{children}</AuthProvider>
      </AntApp>
    </ConfigProvider>
  );
}
