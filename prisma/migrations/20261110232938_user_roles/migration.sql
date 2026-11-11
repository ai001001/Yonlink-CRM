-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('ADMIN', 'MANAGER', 'SALES', 'READONLY');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "is_demo" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "role" "user_role" NOT NULL DEFAULT 'SALES';

-- 已有用户（迁移前创建的组织管理员）设为系统管理员，避免升级后无人可管理
-- Existing users (organization admins created before this migration) become ADMIN so nobody is locked out
UPDATE "users" SET "role" = 'ADMIN';
