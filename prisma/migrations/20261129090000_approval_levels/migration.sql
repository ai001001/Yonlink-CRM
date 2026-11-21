-- AlterTable
ALTER TABLE "quote_approvals" ADD COLUMN     "step" INTEGER;

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "approval_step" INTEGER,
ADD COLUMN     "approval_steps" JSONB;

-- CreateTable
CREATE TABLE "quote_approval_levels" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "approver_role" "user_role" NOT NULL,
    "min_discount_percent" DECIMAL(5,2),
    "min_total" DECIMAL(18,2),

    CONSTRAINT "quote_approval_levels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quote_approval_levels_organization_id_position_key" ON "quote_approval_levels"("organization_id", "position");

-- AddForeignKey
ALTER TABLE "quote_approval_levels" ADD CONSTRAINT "quote_approval_levels_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- 手工约束与数据迁移 / Hand-written constraints and data migration
-- 已在审批中的报价单：按原规则补为一级审批（任一审批人）/ quotes already pending become a single level (any approver)
UPDATE "quotes" SET "approval_step" = 0, "approval_steps" = '[{"name": null, "role": null}]'::jsonb WHERE "approval_status" = 'PENDING';

-- 只在待审批时有当前级别；级别快照为数组 / the current level exists only while pending; the snapshot is an array
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_approval_step_check" CHECK (
  ("approval_step" IS NOT NULL) = ("approval_status" IS NOT DISTINCT FROM 'PENDING')
  AND ("approval_step" IS NULL OR "approval_step" >= 0)
  AND ("approval_steps" IS NULL OR jsonb_typeof("approval_steps") = 'array')
);
ALTER TABLE "quote_approvals" ADD CONSTRAINT "quote_approvals_step_check" CHECK ("step" IS NULL OR "step" >= 0);

-- 级别：顺序 0–4；名称非空白；审批角色为经理或管理员；折扣 0–100、金额非负
-- levels: position 0–4; non-blank names; manager or admin approvers; discount 0–100, non-negative amount
ALTER TABLE "quote_approval_levels" ADD CONSTRAINT "quote_approval_levels_check" CHECK (
  "position" BETWEEN 0 AND 4 AND btrim("name") <> '' AND "approver_role" IN ('ADMIN', 'MANAGER')
  AND ("min_discount_percent" IS NULL OR "min_discount_percent" BETWEEN 0 AND 100)
  AND ("min_total" IS NULL OR "min_total" >= 0)
);
