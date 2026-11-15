-- CreateEnum
CREATE TYPE "deal_contact_role_type" AS ENUM ('DECISION_MAKER', 'EVALUATOR', 'INFLUENCER', 'TECHNICAL_BUYER', 'PURCHASING', 'END_USER', 'OTHER');

-- CreateEnum
CREATE TYPE "competitor_threat" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "deal_contact_roles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "role" "deal_contact_role_type" NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "deal_contact_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_competitors" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "threat_level" "competitor_threat" NOT NULL DEFAULT 'MEDIUM',
    "strengths" TEXT,
    "weaknesses" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "deal_competitors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deal_contact_roles_organization_id_contact_id_idx" ON "deal_contact_roles"("organization_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "deal_contact_roles_organization_id_deal_id_contact_id_key" ON "deal_contact_roles"("organization_id", "deal_id", "contact_id");

-- CreateIndex
CREATE INDEX "deal_competitors_organization_id_deal_id_idx" ON "deal_competitors"("organization_id", "deal_id");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_organization_id_id_key" ON "contacts"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "deal_contact_roles" ADD CONSTRAINT "deal_contact_roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_contact_roles" ADD CONSTRAINT "deal_contact_roles_organization_id_deal_id_fkey" FOREIGN KEY ("organization_id", "deal_id") REFERENCES "deals"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_contact_roles" ADD CONSTRAINT "deal_contact_roles_organization_id_contact_id_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_competitors" ADD CONSTRAINT "deal_competitors_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_competitors" ADD CONSTRAINT "deal_competitors_organization_id_deal_id_fkey" FOREIGN KEY ("organization_id", "deal_id") REFERENCES "deals"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 手工约束 / Hand-written constraints
-- 每个商机最多一个主要联系人 / at most one primary contact per deal
CREATE UNIQUE INDEX "deal_contact_roles_one_primary_key" ON "deal_contact_roles"("organization_id", "deal_id") WHERE "is_primary";
-- 竞争对手名称在同一商机内唯一（不区分大小写）且不能为空白 / competitor names are unique per deal (case-insensitive) and non-blank
CREATE UNIQUE INDEX "deal_competitors_name_key" ON "deal_competitors"("organization_id", "deal_id", lower("name"));
ALTER TABLE "deal_competitors" ADD CONSTRAINT "deal_competitors_name_check" CHECK (btrim("name") <> '');
