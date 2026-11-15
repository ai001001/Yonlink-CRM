-- CreateEnum
CREATE TYPE "ticket_status" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ticket_priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ticket_type" AS ENUM ('QUESTION', 'PROBLEM', 'FEATURE_REQUEST');

-- CreateEnum
CREATE TYPE "ticket_channel" AS ENUM ('PHONE', 'EMAIL', 'WEB', 'ONSITE', 'OTHER');

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "ticket_id" UUID;

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "ticket_number" VARCHAR(20) NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "account_id" UUID NOT NULL,
    "contact_id" UUID,
    "owner_id" UUID,
    "status" "ticket_status" NOT NULL DEFAULT 'OPEN',
    "priority" "ticket_priority" NOT NULL DEFAULT 'MEDIUM',
    "type" "ticket_type" NOT NULL DEFAULT 'QUESTION',
    "channel" "ticket_channel" NOT NULL DEFAULT 'PHONE',
    "due_at" TIMESTAMPTZ(6),
    "resolution" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tickets_organization_id_status_idx" ON "tickets"("organization_id", "status");

-- CreateIndex
CREATE INDEX "tickets_organization_id_account_id_idx" ON "tickets"("organization_id", "account_id");

-- CreateIndex
CREATE INDEX "tickets_organization_id_owner_id_idx" ON "tickets"("organization_id", "owner_id");

-- CreateIndex
CREATE INDEX "tickets_organization_id_created_at_idx" ON "tickets"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tickets_organization_id_id_key" ON "tickets"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_organization_id_ticket_number_key" ON "tickets"("organization_id", "ticket_number");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_ticket_id_fkey" FOREIGN KEY ("organization_id", "ticket_id") REFERENCES "tickets"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_contact_id_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_owner_id_fkey" FOREIGN KEY ("organization_id", "owner_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- 手工约束 / Hand-written constraints
-- 已解决、已关闭必须有解决方案与解决时间；其他状态不能有解决时间
-- resolved/closed tickets need a resolution and resolved time; other statuses have no resolved time
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_resolution_check" CHECK (
  ("status" IN ('RESOLVED', 'CLOSED') AND "resolved_at" IS NOT NULL AND "resolution" IS NOT NULL AND btrim("resolution") <> '')
  OR ("status" NOT IN ('RESOLVED', 'CLOSED') AND "resolved_at" IS NULL)
);
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_subject_check" CHECK (btrim("subject") <> '');
-- 通知恰好指向一个对象（新增工单）/ a notification targets exactly one record (tickets added)
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_one_target_check";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_one_target_check" CHECK (num_nonnulls("lead_id", "account_id", "deal_id", "activity_id", "ticket_id") = 1);
