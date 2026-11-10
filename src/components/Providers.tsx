/**
 * 全局 Provider：主题、中文语言包、登录状态。
 * Global providers: theme, Chinese locale and auth state.
 */
'use client';

import type { ReactNode } from 'react';
import { App as AntApp, ConfigProvider } from 'antd';
import zh from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { AuthProvider } from './AuthProvider';

dayjs.locale('zh-cn');

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider locale={zh} theme={{ token: { colorPrimary: '#1f5fbf', borderRadius: 6 } }}>
      <AntApp>
        <AuthProvider>{children}</AuthProvider>
      </AntApp>
    </ConfigProvider>
  );
}
