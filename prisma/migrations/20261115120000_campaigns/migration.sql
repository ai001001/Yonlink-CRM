-- CreateEnum
CREATE TYPE "campaign_type" AS ENUM ('EXHIBITION', 'ADVERTISEMENT', 'EMAIL', 'WEBINAR', 'SOCIAL_MEDIA', 'OTHER');

-- CreateEnum
CREATE TYPE "campaign_status" AS ENUM ('PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "deals" ADD COLUMN     "campaign_id" UUID;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "campaign_id" UUID;

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "type" "campaign_type" NOT NULL,
    "status" "campaign_status" NOT NULL DEFAULT 'PLANNED',
    "start_date" DATE,
    "end_date" DATE,
    "currency" CHAR(3) NOT NULL DEFAULT 'CNY',
    "budget" DECIMAL(18,2),
    "actual_cost" DECIMAL(18,2),
    "description" TEXT,
    "owner_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_organization_id_status_idx" ON "campaigns"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_organization_id_id_key" ON "campaigns"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_organization_id_name_key" ON "campaigns"("organization_id", "name");

-- CreateIndex
CREATE INDEX "deals_organization_id_campaign_id_idx" ON "deals"("organization_id", "campaign_id");

-- CreateIndex
CREATE INDEX "leads_organization_id_campaign_id_idx" ON "leads"("organization_id", "campaign_id");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_campaign_id_fkey" FOREIGN KEY ("organization_id", "campaign_id") REFERENCES "campaigns"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_organization_id_campaign_id_fkey" FOREIGN KEY ("organization_id", "campaign_id") REFERENCES "campaigns"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_owner_id_fkey" FOREIGN KEY ("organization_id", "owner_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- 金额非负、结束不早于开始、币种为三位大写字母 / non-negative money, end not before start, ISO-style currency
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_amounts_check" CHECK (("budget" IS NULL OR "budget" >= 0) AND ("actual_cost" IS NULL OR "actual_cost" >= 0));
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_dates_check" CHECK ("start_date" IS NULL OR "end_date" IS NULL OR "end_date" >= "start_date");
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
