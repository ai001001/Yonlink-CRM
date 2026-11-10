-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "converted_account_id" UUID,
ADD COLUMN     "converted_at" TIMESTAMPTZ(6),
ADD COLUMN     "converted_contact_id" UUID,
ADD COLUMN     "converted_deal_id" UUID;

-- CreateIndex
CREATE INDEX "leads_converted_account_id_idx" ON "leads"("converted_account_id");

-- CreateIndex
CREATE INDEX "leads_converted_contact_id_idx" ON "leads"("converted_contact_id");

-- CreateIndex
CREATE INDEX "leads_converted_deal_id_idx" ON "leads"("converted_deal_id");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_account_id_fkey" FOREIGN KEY ("converted_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_contact_id_fkey" FOREIGN KEY ("converted_contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_deal_id_fkey" FOREIGN KEY ("converted_deal_id") REFERENCES "deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 纵深防御：转化结果必须指向同一组织的记录（单列外键无法表达，使用触发器）
-- Defense in depth: conversion links must point at records of the same organization
-- (single-column FKs cannot express it, so a trigger enforces it)
CREATE FUNCTION "leads_conversion_same_org"() RETURNS trigger AS $$
BEGIN
  IF NEW."converted_account_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "accounts" WHERE "id" = NEW."converted_account_id" AND "organization_id" = NEW."organization_id") THEN
    RAISE EXCEPTION 'converted_account_id belongs to another organization' USING ERRCODE = '23503';
  END IF;
  IF NEW."converted_contact_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "contacts" WHERE "id" = NEW."converted_contact_id" AND "organization_id" = NEW."organization_id") THEN
    RAISE EXCEPTION 'converted_contact_id belongs to another organization' USING ERRCODE = '23503';
  END IF;
  IF NEW."converted_deal_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "deals" WHERE "id" = NEW."converted_deal_id" AND "organization_id" = NEW."organization_id") THEN
    RAISE EXCEPTION 'converted_deal_id belongs to another organization' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "leads_conversion_same_org"
  BEFORE INSERT OR UPDATE OF "converted_account_id", "converted_contact_id", "converted_deal_id", "organization_id" ON "leads"
  FOR EACH ROW EXECUTE FUNCTION "leads_conversion_same_org"();

-- 已转化状态与转化时间一致 / CONVERTED status requires converted_at and vice versa
ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_consistent"
  CHECK (("status" = 'CONVERTED') = ("converted_at" IS NOT NULL));
