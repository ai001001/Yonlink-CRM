/**
 * 由 src/app/icon.svg 生成可安装网页应用的 PNG 图标（public/ 下）；图标变化后手工运行一次：node scripts/gen-app-icons.mjs
 * Generate the installable web-app PNG icons (in public/) from src/app/icon.svg; run by hand after changing the icon.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const svg = readFileSync('src/app/icon.svg');
// 普通图标：原图缩放 / regular icons: the original scaled
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  await sharp(svg, { density: 512 }).resize(size, size).png().toFile(`public/${name}`);
}
// 可裁切图标：品牌蓝满底，图形缩到安全区（80%）内 / maskable: full brand-blue bleed, artwork inside the 80% safe zone
const inner = await sharp(svg, { density: 512 }).resize(410, 410).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#1f5fbf' } })
  .composite([{ input: inner, gravity: 'center' }])
  .png()
  .toFile('public/icon-maskable-512.png');
// favicon.ico：内嵌 48×48 PNG 的 ICO 文件（浏览器会自动请求该地址）/ favicon.ico: an ICO wrapping a 48×48 PNG (browsers request it on their own)
const png = await sharp(svg, { density: 512 }).resize(48, 48).png().toBuffer();
const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0); // 保留 / reserved
header.writeUInt16LE(1, 2); // 类型：图标 / type: icon
header.writeUInt16LE(1, 4); // 图像数 / image count
header.writeUInt8(48, 6); // 宽 / width
header.writeUInt8(48, 7); // 高 / height
header.writeUInt8(0, 8); // 调色板 / palette
header.writeUInt8(0, 9); // 保留 / reserved
header.writeUInt16LE(1, 10); // 颜色平面 / colour planes
header.writeUInt16LE(32, 12); // 位深 / bits per pixel
header.writeUInt32LE(png.length, 14); // 数据长度 / data size
header.writeUInt32LE(22, 18); // 数据偏移 / data offset
writeFileSync('public/favicon.ico', Buffer.concat([header, png]));
console.log('icons written / 图标已生成');
