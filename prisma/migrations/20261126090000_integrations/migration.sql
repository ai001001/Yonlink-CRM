-- CreateEnum
CREATE TYPE "webhook_delivery_status" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "prefix" VARCHAR(16) NOT NULL,
    "key_hash" CHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "created_by_id" UUID,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "secret" VARCHAR(64) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "webhook_id" UUID NOT NULL,
    "event" VARCHAR(50) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "webhook_delivery_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_status_code" INTEGER,
    "last_error" VARCHAR(500),
    "delivered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_organization_id_created_at_idx" ON "api_keys"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhooks_organization_id_id_key" ON "webhooks"("organization_id", "id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_organization_id_webhook_id_created_at_idx" ON "webhook_deliveries"("organization_id", "webhook_id", "created_at");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_user_id_fkey" FOREIGN KEY ("organization_id", "user_id") REFERENCES "users"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_created_by_id_fkey" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_organization_id_created_by_id_fkey" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organization_id_webhook_id_fkey" FOREIGN KEY ("organization_id", "webhook_id") REFERENCES "webhooks"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;



-- 手工约束 / Hand-written constraints
-- 名称非空白；密钥哈希为 64 位十六进制、前缀以 ylk_ 开头；Webhook 地址为 http(s)、名称组织内唯一；尝试次数非负
-- non-blank names; 64-hex key hashes with a ylk_ prefix; http(s) webhook URLs with unique names; non-negative attempts
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_check" CHECK (btrim("name") <> '' AND "key_hash" ~ '^[0-9a-f]{64}$' AND "prefix" LIKE 'ylk\_%');
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_check" CHECK (btrim("name") <> '' AND "url" ~ '^https?://' AND length("secret") >= 32);
CREATE UNIQUE INDEX "webhooks_name_key" ON "webhooks"("organization_id", lower("name"));
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_check" CHECK ("attempts" >= 0 AND btrim("event") <> '');
