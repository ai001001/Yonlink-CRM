-- CreateEnum
CREATE TYPE "picklist_field" AS ENUM ('LEAD_SOURCE', 'INDUSTRY', 'LEAD_STATUS', 'DEAL_STAGE', 'ACTIVITY_TYPE');

-- CreateTable
CREATE TABLE "picklist_values" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "field" "picklist_field" NOT NULL,
    "value" VARCHAR(30) NOT NULL,
    "label" VARCHAR(50),
    "position" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "probability" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "picklist_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "picklist_values_organization_id_field_position_idx" ON "picklist_values"("organization_id", "field", "position");

-- CreateIndex
CREATE UNIQUE INDEX "picklist_values_organization_id_field_value_key" ON "picklist_values"("organization_id", "field", "value");

-- AddForeignKey
ALTER TABLE "picklist_values" ADD CONSTRAINT "picklist_values_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 选项代码格式；名称去空白且非空；位置非负 / code format; trimmed non-empty labels; non-negative positions
-- 赢单概率只用于进行中的商机阶段（0–100）/ win probability only on open deal stages (0–100)
-- 不能停用的选项：线索“新建”“已转化”，商机“赢单”“输单” / options that cannot be deactivated
ALTER TABLE "picklist_values" ADD CONSTRAINT "picklist_values_check" CHECK (
  "value" ~ '^[A-Z][A-Z0-9_]{0,29}$'
  AND ("label" IS NULL OR ("label" = btrim("label") AND "label" <> ''))
  AND "position" >= 0
  AND ("probability" IS NULL OR ("field" = 'DEAL_STAGE' AND "value" NOT IN ('CLOSED_WON', 'CLOSED_LOST') AND "probability" BETWEEN 0 AND 100))
  AND NOT ("field" = 'LEAD_STATUS' AND "value" IN ('NEW', 'CONVERTED') AND NOT "is_active")
  AND NOT ("field" = 'DEAL_STAGE' AND "value" IN ('CLOSED_WON', 'CLOSED_LOST') AND NOT "is_active")
);
-- 同一字段内名称不区分大小写唯一 / labels unique per field, case-insensitive
CREATE UNIQUE INDEX "picklist_values_label_key" ON "picklist_values"("organization_id", "field", lower("label"));
