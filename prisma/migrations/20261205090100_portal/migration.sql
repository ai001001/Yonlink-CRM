-- CreateEnum
CREATE TYPE "portal_user_status" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED');

-- AlterTable
ALTER TABLE "ticket_comments" ADD COLUMN     "portal_user_id" UUID,
ALTER COLUMN "author_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "portal_settings" (
    "organization_id" UUID NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "portal_key" VARCHAR(32) NOT NULL,
    "welcome" VARCHAR(500),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "portal_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "portal_users" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password_hash" TEXT,
    "status" "portal_user_status" NOT NULL DEFAULT 'INVITED',
    "invite_token_hash" CHAR(64),
    "invite_expires_at" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "invited_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "portal_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portal_sessions" (
    "id" UUID NOT NULL,
    "portal_user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "portal_settings_portal_key_key" ON "portal_settings"("portal_key");

-- CreateIndex
CREATE UNIQUE INDEX "portal_users_invite_token_hash_key" ON "portal_users"("invite_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "portal_users_organization_id_id_key" ON "portal_users"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "portal_users_organization_id_contact_id_key" ON "portal_users"("organization_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "portal_users_organization_id_email_key" ON "portal_users"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "portal_sessions_token_hash_key" ON "portal_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "portal_sessions_portal_user_id_idx" ON "portal_sessions"("portal_user_id");

-- AddForeignKey
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_organization_id_portal_user_id_fkey" FOREIGN KEY ("organization_id", "portal_user_id") REFERENCES "portal_users"("organization_id", "id") ON DELETE SET NULL ("portal_user_id") ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "portal_settings" ADD CONSTRAINT "portal_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_users" ADD CONSTRAINT "portal_users_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_users" ADD CONSTRAINT "portal_users_organization_id_contact_id_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "portal_users" ADD CONSTRAINT "portal_users_organization_id_invited_by_id_fkey" FOREIGN KEY ("organization_id", "invited_by_id") REFERENCES "users"("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "portal_sessions" ADD CONSTRAINT "portal_sessions_portal_user_id_fkey" FOREIGN KEY ("portal_user_id") REFERENCES "portal_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 手工修改：上一行的 SET NULL 只置空 portal_user_id（不能置空 organization_id）
-- hand edit: the SET NULL above clears portal_user_id only (organization_id must stay)



-- 手工约束 / Hand-written constraints
-- 评论作者：员工与门户用户不能同时存在（门户用户删除后两者都可为空，评论保留）
-- comment author: not both staff and portal user (both may be null after a portal user is deleted; the comment stays)
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_author_check" CHECK (NOT ("author_id" IS NOT NULL AND "portal_user_id" IS NOT NULL));

-- 门户用户：邮箱为小写且非空白；邀请中必有邀请令牌与期限；启用必有密码
-- portal users: lower-case non-blank email; invited ones have a token and expiry; active ones a password
ALTER TABLE "portal_users" ADD CONSTRAINT "portal_users_check" CHECK (
  btrim("email") <> '' AND "email" = lower("email")
  AND ("status" <> 'INVITED' OR ("invite_token_hash" IS NOT NULL AND "invite_expires_at" IS NOT NULL))
  AND ("status" <> 'ACTIVE' OR "password_hash" IS NOT NULL)
  AND (("invite_token_hash" IS NULL) = ("invite_expires_at" IS NULL))
);

-- 门户设置：标识只含 URL 安全字符；欢迎语非空白 / portal settings: URL-safe key; non-blank welcome
ALTER TABLE "portal_settings" ADD CONSTRAINT "portal_settings_check" CHECK (
  "portal_key" ~ '^[A-Za-z0-9_-]{16,32}$' AND ("welcome" IS NULL OR btrim("welcome") <> '')
);
