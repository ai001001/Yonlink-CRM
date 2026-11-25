/**
 * 移动端 第二轮：集成测试（可点拨电话与邮箱链接的地址规则；可安装网页应用清单与图标文件：字段、相对地址、图标真实尺寸与
 * 可裁切图标；根布局在两种构建下的清单、图标地址与视口设置）。
 * Mobile round 2: integration tests for link targets, the web-app manifest and icons, and the root layout metadata.
 */
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mailHref, telHref } from '@/lib/phone';

describe('mobile R2 links', () => {
  it('电话链接只保留数字、+、-、括号 / tel targets keep digits, +, - and parentheses', () => {
    expect(telHref('+86 138 0000 0000')).toBe('tel:+8613800000000');
    expect(telHref('(021) 5555-0123')).toBe('tel:(021)5555-0123');
    // 分机号用暂停符接在后面 / extensions follow a pause
    expect(telHref('+1 312 555 0141 转 8')).toBe('tel:+13125550141,8');
    expect(telHref('021-5555 0123 ext. 204')).toBe('tel:021-55550123,204');
    expect(telHref('0755 8888 0000 x12')).toBe('tel:075588880000,12');
    // 任何文本都只剩安全字符 / any text is reduced to safe characters
    expect(telHref('javascript:alert(1)')).toBe('tel:(1)');
    expect(telHref('无')).toBeNull();
    expect(telHref('')).toBeNull();
    expect(telHref(null)).toBeNull();
    expect(telHref(undefined)).toBeNull();
  });

  it('邮箱链接只接受普通邮箱 / mailto targets accept plain addresses only', () => {
    expect(mailHref(' buyer@example.com ')).toBe('mailto:buyer@example.com');
    expect(mailHref('a@b')).toBeNull();
    expect(mailHref('a b@example.com')).toBeNull();
    expect(mailHref('x@example.com?subject=hi')).toBeNull();
    expect(mailHref('"><script>@example.com')).toBeNull();
    expect(mailHref(null)).toBeNull();
  });
});

describe('mobile R2 manifest and icons', () => {
  const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));

  it('清单字段与相对地址（两种部署路径都可用）/ manifest fields with relative URLs (works under both base paths)', () => {
    expect(manifest).toMatchObject({ short_name: '永联CRM', display: 'standalone', start_url: './', scope: './', theme_color: '#1f5fbf', background_color: '#f4f6fa' });
    expect(manifest.name).toContain('永联CRM');
    for (const icon of manifest.icons) expect(icon.src).not.toMatch(/^\//);
  });

  it('图标文件存在且尺寸与声明一致；有可裁切图标 / icons exist with declared sizes; a maskable one exists', async () => {
    for (const icon of manifest.icons as { src: string; sizes: string; type: string; purpose: string }[]) {
      const meta = await sharp(`public/${icon.src}`).metadata();
      expect(`${meta.width}x${meta.height}`, icon.src).toBe(icon.sizes);
      expect(meta.format).toBe('png');
      expect(icon.type).toBe('image/png');
    }
    expect(manifest.icons.some((i: { purpose: string; sizes: string }) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true);
    expect(manifest.icons.some((i: { sizes: string }) => i.sizes === '192x192')).toBe(true);
    const apple = await sharp('public/apple-touch-icon.png').metadata();
    expect([apple.width, apple.height]).toEqual([180, 180]);
    // 可裁切图标四角是品牌蓝满底（不透明）/ the maskable icon bleeds brand blue to the corners (opaque)
    const { data } = await sharp('public/icon-maskable-512.png').raw().toBuffer({ resolveWithObject: true });
    expect(Array.from(data.subarray(0, 4))).toEqual([0x1f, 0x5f, 0xbf, 255]);
  });

  it('favicon.ico 是有效的 ICO（内嵌 48×48 PNG）/ favicon.ico is a valid ICO wrapping a 48×48 PNG', async () => {
    const ico = readFileSync('public/favicon.ico');
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 1]);
    expect([ico[6], ico[7]]).toEqual([48, 48]);
    const offset = ico.readUInt32LE(18);
    const png = ico.subarray(offset, offset + ico.readUInt32LE(14));
    const meta = await sharp(png).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 48, 48]);
  });
});

describe('mobile R2 root layout', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('静态前端构建时清单与图标带子路径；服务端构建不带 / the static build prefixes the sub-path; the server build does not', async () => {
    vi.stubEnv('BUILD_TARGET', 'pages');
    vi.resetModules();
    const pages = await import('@/app/layout');
    expect(pages.metadata.manifest).toBe('/Yonlink-CRM/manifest.webmanifest');
    expect(pages.metadata.icons).toEqual({ apple: '/Yonlink-CRM/apple-touch-icon.png' });
    vi.stubEnv('BUILD_TARGET', '');
    vi.resetModules();
    const server = await import('@/app/layout');
    expect(server.metadata.manifest).toBe('/manifest.webmanifest');
    expect(server.viewport).toMatchObject({ width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#1f5fbf' });
    expect(server.metadata.appleWebApp).toMatchObject({ capable: true });
  });
});
