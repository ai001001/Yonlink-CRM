-- AlterEnum
ALTER TYPE "notification_type" ADD VALUE 'TICKET_ESCALATED';

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "due_auto" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "escalated_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "ticket_sla_policies" (
    "organization_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "urgent_hours" INTEGER NOT NULL,
    "high_hours" INTEGER NOT NULL,
    "medium_hours" INTEGER NOT NULL,
    "low_hours" INTEGER NOT NULL,
    "escalate_to_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ticket_sla_policies_pkey" PRIMARY KEY ("organization_id")
);

-- AddForeignKey
ALTER TABLE "ticket_sla_policies" ADD CONSTRAINT "ticket_sla_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_sla_policies" ADD CONSTRAINT "ticket_sla_policies_organization_id_escalate_to_id_fkey" FOREIGN KEY ("organization_id", "escalate_to_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- 手工约束 / Hand-written constraints
-- 时限为 1 小时到 1 年 / limits between 1 hour and 1 year
ALTER TABLE "ticket_sla_policies" ADD CONSTRAINT "ticket_sla_policies_hours_check" CHECK (
  "urgent_hours" BETWEEN 1 AND 8760 AND "high_hours" BETWEEN 1 AND 8760 AND "medium_hours" BETWEEN 1 AND 8760 AND "low_hours" BETWEEN 1 AND 8760
);
-- 升级扫描：未升级、有期限的工单 / escalation sweep: unescalated tickets with a due time
CREATE INDEX "tickets_sla_sweep_idx" ON "tickets"("organization_id", "due_at") WHERE "escalated_at" IS NULL AND "due_at" IS NOT NULL;
