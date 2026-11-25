/**
 * 根布局：Ant Design 样式注册与中文语言包。
 * Root layout: Ant Design style registry and Chinese locale.
 */
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import { Providers } from '@/components/Providers';
import { t } from '@/i18n';
import './globals.css';

// 页面标题由客户端按当前语言设置（见 Providers），元数据只提供品牌名，避免覆盖用户选择的语言
// the document title is set client-side in the current locale (see Providers); metadata only carries the brand
// 静态前端（GitHub Pages）部署在子路径下，清单与图标地址须带上该路径 / the static frontend lives under a sub-path, so the manifest and icons need it
const base = process.env.BUILD_TARGET === 'pages' ? '/Yonlink-CRM' : '';

export const metadata: Metadata = {
  applicationName: t('app.brand'),
  // 可安装网页应用：清单、主屏图标；iOS 以全屏方式打开 / installable web app: manifest and home-screen icon; iOS opens it full screen
  manifest: `${base}/manifest.webmanifest`,
  icons: { apple: `${base}/apple-touch-icon.png` },
  appleWebApp: { capable: true, title: t('app.name'), statusBarStyle: 'default' },
};

/** 视口：随设备宽度、主题色、适配全面屏安全区 / viewport: device width, theme colour, safe-area aware */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#1f5fbf',
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
