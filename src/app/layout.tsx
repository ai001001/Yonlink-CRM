/**
 * 根布局：Ant Design 样式注册与中文语言包。
 * Root layout: Ant Design style registry and Chinese locale.
 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import { Providers } from '@/components/Providers';
import { t } from '@/i18n';
import './globals.css';

// 页面标题由客户端按当前语言设置（见 Providers），元数据只提供品牌名，避免覆盖用户选择的语言
// the document title is set client-side in the current locale (see Providers); metadata only carries the brand
export const metadata: Metadata = {
  applicationName: t('app.brand'),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <Providers>{children}</Providers>
        </AntdRegistry>
      </body>
    </html>
  );
}
