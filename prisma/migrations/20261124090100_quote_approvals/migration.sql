-- CreateEnum
CREATE TYPE "approval_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "approval_action" AS ENUM ('SUBMIT', 'APPROVE', 'REJECT', 'RECALL');

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "approval_reasons" JSONB,
ADD COLUMN     "approval_status" "approval_status";

-- CreateTable
CREATE TABLE "quote_approval_settings" (
    "organization_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "max_discount_percent" DECIMAL(5,2),
    "min_total" DECIMAL(18,2),
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "quote_approval_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "quote_approvals" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "action" "approval_action" NOT NULL,
    "actor_id" UUID NOT NULL,
    "comment" VARCHAR(500),
    "reasons" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quote_approvals_organization_id_quote_id_created_at_idx" ON "quote_approvals"("organization_id", "quote_id", "created_at");

-- AddForeignKey
ALTER TABLE "quote_approval_settings" ADD CONSTRAINT "quote_approval_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_approval_settings" ADD CONSTRAINT "quote_approval_settings_organization_id_updated_by_id_fkey" FOREIGN KEY ("organization_id", "updated_by_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quote_approvals" ADD CONSTRAINT "quote_approvals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_approvals" ADD CONSTRAINT "quote_approvals_organization_id_quote_id_fkey" FOREIGN KEY ("organization_id", "quote_id") REFERENCES "quotes"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_approvals" ADD CONSTRAINT "quote_approvals_organization_id_actor_id_fkey" FOREIGN KEY ("organization_id", "actor_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;



-- 手工约束与触发器 / Hand-written constraints and triggers
-- 待审批只出现在草稿上；审批原因与状态同时存在 / pending only on drafts; reasons go with a status
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_approval_check" CHECK (
  ("approval_status" IS DISTINCT FROM 'PENDING' OR "status" = 'DRAFT')
  AND ("approval_reasons" IS NULL OR "approval_status" IS NOT NULL)
);
-- 规则：折扣上限 0–100；金额非负 / policy: discount cap 0–100; non-negative amount
ALTER TABLE "quote_approval_settings" ADD CONSTRAINT "quote_approval_settings_check" CHECK (
  ("max_discount_percent" IS NULL OR "max_discount_percent" BETWEEN 0 AND 100)
  AND ("min_total" IS NULL OR "min_total" >= 0)
);
-- 审批意见非空白 / comments are not blank
ALTER TABLE "quote_approvals" ADD CONSTRAINT "quote_approvals_check" CHECK ("comment" IS NULL OR btrim("comment") <> '');

-- 审批历史只增不改 / approval history is append-only
CREATE FUNCTION "quote_approvals_no_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'quote approval history is append-only' USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "quote_approvals_no_update"
  BEFORE UPDATE ON "quote_approvals"
  FOR EACH ROW EXECUTE FUNCTION "quote_approvals_no_update"();
