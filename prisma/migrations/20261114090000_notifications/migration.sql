-- CreateEnum
CREATE TYPE "notification_type" AS ENUM ('ASSIGNED', 'ACTIVITY_DUE');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "notification_type" NOT NULL,
    "actor_id" UUID,
    "lead_id" UUID,
    "account_id" UUID,
    "deal_id" UUID,
    "activity_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "due_at" TIMESTAMPTZ(6),
    "dedup_key" VARCHAR(100),
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_organization_id_user_id_created_at_idx" ON "notifications"("organization_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "notifications_organization_id_activity_id_idx" ON "notifications"("organization_id", "activity_id");

-- CreateIndex
CREATE INDEX "notifications_organization_id_lead_id_idx" ON "notifications"("organization_id", "lead_id");

-- CreateIndex
CREATE INDEX "notifications_organization_id_account_id_idx" ON "notifications"("organization_id", "account_id");

-- CreateIndex
CREATE INDEX "notifications_organization_id_deal_id_idx" ON "notifications"("organization_id", "deal_id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_dedup_key_key" ON "notifications"("user_id", "dedup_key");

-- CreateIndex
CREATE UNIQUE INDEX "activities_organization_id_id_key" ON "activities"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_user_id_fkey" FOREIGN KEY ("organization_id", "user_id") REFERENCES "users"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_actor_id_fkey" FOREIGN KEY ("organization_id", "actor_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_lead_id_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "accounts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_deal_id_fkey" FOREIGN KEY ("organization_id", "deal_id") REFERENCES "deals"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_activity_id_fkey" FOREIGN KEY ("organization_id", "activity_id") REFERENCES "activities"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 恰好关联一条记录 / linked to exactly one record
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_one_target_check" CHECK (num_nonnulls("lead_id", "account_id", "deal_id", "activity_id") = 1);

-- 跟进提醒必须关联跟进并带到期时间与去重键 / activity reminders carry the activity, due time and dedup key
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_due_check" CHECK ("type" <> 'ACTIVITY_DUE' OR ("activity_id" IS NOT NULL AND "due_at" IS NOT NULL AND "dedup_key" IS NOT NULL));
