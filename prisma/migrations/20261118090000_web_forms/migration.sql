-- AlterEnum
ALTER TYPE "notification_type" ADD VALUE 'WEB_FORM_LEAD';

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "web_form_id" UUID;

-- CreateTable
CREATE TABLE "web_forms" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "public_key" VARCHAR(64) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "title" VARCHAR(200) NOT NULL,
    "intro" VARCHAR(1000),
    "fields" VARCHAR(30)[],
    "required_fields" VARCHAR(30)[],
    "source" VARCHAR(50) NOT NULL DEFAULT 'WEBSITE',
    "owner_id" UUID,
    "campaign_id" UUID,
    "success_message" VARCHAR(500),
    "submission_count" INTEGER NOT NULL DEFAULT 0,
    "last_submitted_at" TIMESTAMPTZ(6),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "web_forms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "web_forms_public_key_key" ON "web_forms"("public_key");

-- CreateIndex
CREATE INDEX "web_forms_organization_id_is_active_idx" ON "web_forms"("organization_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "web_forms_organization_id_id_key" ON "web_forms"("organization_id", "id");

-- CreateIndex
CREATE INDEX "leads_web_form_id_idx" ON "leads"("web_form_id");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_web_form_id_fkey" FOREIGN KEY ("web_form_id") REFERENCES "web_forms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "web_forms" ADD CONSTRAINT "web_forms_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "web_forms" ADD CONSTRAINT "web_forms_organization_id_owner_id_fkey" FOREIGN KEY ("organization_id", "owner_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "web_forms" ADD CONSTRAINT "web_forms_organization_id_created_by_id_fkey" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "web_forms" ADD CONSTRAINT "web_forms_organization_id_campaign_id_fkey" FOREIGN KEY ("organization_id", "campaign_id") REFERENCES "campaigns"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;



-- 手工约束 / Hand-written constraints
-- 表单名称组织内唯一（不区分大小写）、非空白；标题非空白；公开标识长度；字段只能取固定集合，必填字段必须已启用；提交数非负
-- unique case-insensitive non-blank names; non-blank title; key length; fields from a fixed set, required ⊆ enabled; count ≥ 0
CREATE UNIQUE INDEX "web_forms_name_key" ON "web_forms"("organization_id", lower("name"));
ALTER TABLE "web_forms" ADD CONSTRAINT "web_forms_check" CHECK (
  btrim("name") <> '' AND btrim("title") <> '' AND length("public_key") >= 32
  AND coalesce("fields", '{}') <@ ARRAY['company', 'title', 'email', 'phone', 'mobile', 'description']::varchar[]
  AND coalesce("required_fields", '{}') <@ coalesce("fields", '{}')
  AND "submission_count" >= 0
);

-- 线索的来源网页表单必须属于同一组织（外键只引用 id，组织由触发器保证）
-- a lead's source web form must belong to the same organization (the FK references id only; the trigger checks the org)
CREATE FUNCTION "leads_web_form_same_org"() RETURNS trigger AS $$
BEGIN
  IF NEW."web_form_id" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "web_forms" WHERE "id" = NEW."web_form_id" AND "organization_id" = NEW."organization_id") THEN
    RAISE EXCEPTION 'web form belongs to another organization' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "leads_web_form_same_org"
  BEFORE INSERT OR UPDATE OF "web_form_id", "organization_id" ON "leads"
  FOR EACH ROW EXECUTE FUNCTION "leads_web_form_same_org"();
