/**
 * Prisma 配置：连接串只从环境变量读取。
 * Prisma config: the connection string is read from the environment only.
 */
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  // generate 不需要连接串，CI 中可缺省 / generate needs no URL, so it may be absent in CI
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
