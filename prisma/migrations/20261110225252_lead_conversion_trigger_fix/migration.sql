-- 修复：删除转化出的客户时，外键 SET NULL 与联系人级联删除在同一语句中发生，
-- 旧触发器会检查未改动且已被级联删除的联系人链接而报错。改为只校验本次实际改动且非空的列。
-- Fix: when a converted account is deleted, the FK SET NULL on leads and the contact cascade happen in the
-- same statement; the old trigger re-checked the unchanged (already cascaded) contact link and failed.
-- Only columns that actually changed to a non-null value are validated now.
CREATE OR REPLACE FUNCTION "leads_conversion_same_org"() RETURNS trigger AS $$
DECLARE
  org_changed boolean := TG_OP = 'INSERT' OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id";
BEGIN
  IF NEW."converted_account_id" IS NOT NULL
     AND (org_changed OR NEW."converted_account_id" IS DISTINCT FROM OLD."converted_account_id")
     AND NOT EXISTS (SELECT 1 FROM "accounts" WHERE "id" = NEW."converted_account_id" AND "organization_id" = NEW."organization_id") THEN
    RAISE EXCEPTION 'converted_account_id belongs to another organization' USING ERRCODE = '23503';
  END IF;
  IF NEW."converted_contact_id" IS NOT NULL
     AND (org_changed OR NEW."converted_contact_id" IS DISTINCT FROM OLD."converted_contact_id")
     AND NOT EXISTS (SELECT 1 FROM "contacts" WHERE "id" = NEW."converted_contact_id" AND "organization_id" = NEW."organization_id") THEN
    RAISE EXCEPTION 'converted_contact_id belongs to another organization' USING ERRCODE = '23503';
  END IF;
  IF NEW."converted_deal_id" IS NOT NULL
     AND (org_changed OR NEW."converted_deal_id" IS DISTINCT FROM OLD."converted_deal_id")
     AND NOT EXISTS (SELECT 1 FROM "deals" WHERE "id" = NEW."converted_deal_id" AND "organization_id" = NEW."organization_id") THEN
    RAISE EXCEPTION 'converted_deal_id belongs to another organization' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
