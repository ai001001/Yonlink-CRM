/**
 * Prisma 客户端单例（PostgreSQL 驱动适配器）。
 * Prisma client singleton using the PostgreSQL driver adapter.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * 创建 Prisma 客户端。
 * Create a Prisma client bound to DATABASE_URL.
 * @returns {PrismaClient} 新客户端 / a new client
 */
function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 10 }) });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
