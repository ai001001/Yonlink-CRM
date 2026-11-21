-- CreateEnum
CREATE TYPE "custom_entity" AS ENUM ('LEAD', 'ACCOUNT', 'CONTACT', 'DEAL');

-- CreateEnum
CREATE TYPE "custom_field_type" AS ENUM ('TEXT', 'TEXTAREA', 'NUMBER', 'DATE', 'PICKLIST', 'CHECKBOX', 'URL', 'EMAIL');

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "custom" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "custom" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "deals" ADD COLUMN     "custom" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "custom" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "custom_fields" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "entity" "custom_entity" NOT NULL,
    "key" VARCHAR(30) NOT NULL,
    "label" VARCHAR(50) NOT NULL,
    "type" "custom_field_type" NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "custom_fields_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_fields_organization_id_entity_position_idx" ON "custom_fields"("organization_id", "entity", "position");

-- CreateIndex
CREATE UNIQUE INDEX "custom_fields_organization_id_entity_key_key" ON "custom_fields"("organization_id", "entity", "key");

-- AddForeignKey
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- 手工约束 / Hand-written constraints
-- 记录的自定义值为对象 / custom values are objects
ALTER TABLE "leads" ADD CONSTRAINT "leads_custom_check" CHECK (jsonb_typeof("custom") = 'object');
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_custom_check" CHECK (jsonb_typeof("custom") = 'object');
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_custom_check" CHECK (jsonb_typeof("custom") = 'object');
ALTER TABLE "deals" ADD CONSTRAINT "deals_custom_check" CHECK (jsonb_typeof("custom") = 'object');
-- 字段：键格式 cf_ + 小写字母数字；名称非空白、同一对象内不重复（不分大小写）；选项为数组且最多 50 个；只有下拉有选项；顺序非负
-- fields: key format; non-blank labels unique per entity (case-insensitive); options an array of at most 50, picklists only
CREATE UNIQUE INDEX "custom_fields_label_key" ON "custom_fields"("organization_id", "entity", lower("label"));
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_check" CHECK (
  "key" ~ '^cf_[a-z0-9]{8}$' AND btrim("label") <> '' AND "position" >= 0
  AND jsonb_typeof("options") = 'array' AND jsonb_array_length("options") <= 50
  AND (("type" = 'PICKLIST') = (jsonb_array_length("options") > 0))
);
