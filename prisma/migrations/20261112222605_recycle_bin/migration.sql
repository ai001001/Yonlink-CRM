-- CreateEnum
CREATE TYPE "recycle_entity" AS ENUM ('lead', 'account', 'deal');

-- CreateTable
CREATE TABLE "recycle_bin_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "entity_type" "recycle_entity" NOT NULL,
    "entity_id" UUID NOT NULL,
    "display_name" VARCHAR(200) NOT NULL,
    "summary" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "reserved_numbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deleted_by_id" UUID,
    "deleted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "recycle_bin_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recycle_bin_items_organization_id_deleted_at_idx" ON "recycle_bin_items"("organization_id", "deleted_at" DESC);

-- CreateIndex
CREATE INDEX "recycle_bin_items_organization_id_expires_at_idx" ON "recycle_bin_items"("organization_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "recycle_bin_items_organization_id_entity_type_entity_id_key" ON "recycle_bin_items"("organization_id", "entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "recycle_bin_items" ADD CONSTRAINT "recycle_bin_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recycle_bin_items" ADD CONSTRAINT "recycle_bin_items_organization_id_deleted_by_id_fkey" FOREIGN KEY ("organization_id", "deleted_by_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- 业务约束：过期时间晚于删除时间；名称非空 / Business constraints: expiry after deletion; non-blank name
ALTER TABLE "recycle_bin_items" ADD CONSTRAINT "recycle_bin_items_expiry_after_deletion" CHECK ("expires_at" > "deleted_at");
ALTER TABLE "recycle_bin_items" ADD CONSTRAINT "recycle_bin_items_name_non_blank" CHECK (length(btrim("display_name")) > 0);
