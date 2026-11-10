/**
 * Next.js 配置。BUILD_TARGET=pages 时构建 GitHub Pages 静态前端：
 * 只收集 .tsx 页面（API 的 route.ts 被排除），并设置 basePath。
 * Next.js config. With BUILD_TARGET=pages a static GitHub Pages frontend is built:
 * only .tsx pages are collected (API route.ts files are excluded) and basePath is set.
 */
import type { NextConfig } from 'next';

const isPages = process.env.BUILD_TARGET === 'pages';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: isPages ? 'export' : undefined,
  basePath: isPages ? '/Yonlink-CRM' : undefined,
  trailingSlash: isPages,
  pageExtensions: isPages ? ['tsx'] : ['tsx', 'ts'],
  images: { unoptimized: true },
  serverExternalPackages: ['@node-rs/argon2'],
};

export default nextConfig;
