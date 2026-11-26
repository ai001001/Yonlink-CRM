-- CreateEnum
CREATE TYPE "report_entity" AS ENUM ('LEAD', 'ACCOUNT', 'DEAL', 'ACTIVITY');

-- CreateTable
CREATE TABLE "custom_reports" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "entity" "report_entity" NOT NULL,
    "columns" JSONB NOT NULL DEFAULT '[]',
    "filters" JSONB NOT NULL DEFAULT '[]',
    "group_by" JSONB,
    "measures" JSONB NOT NULL DEFAULT '[]',
    "chart" VARCHAR(10) NOT NULL DEFAULT 'NONE',
    "sort" JSONB,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "custom_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_reports_organization_id_owner_id_idx" ON "custom_reports"("organization_id", "owner_id");

-- CreateIndex
CREATE INDEX "custom_reports_organization_id_shared_idx" ON "custom_reports"("organization_id", "shared");

-- AddForeignKey
ALTER TABLE "custom_reports" ADD CONSTRAINT "custom_reports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_reports" ADD CONSTRAINT "custom_reports_organization_id_owner_id_fkey" FOREIGN KEY ("organization_id", "owner_id") REFERENCES "users"("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;


-- 名称去空白且非空；定义为 JSON 数组或对象；图表类型取固定值；图表需要分组
-- trimmed non-empty names; JSON shapes; fixed chart types; charts need a grouping
ALTER TABLE "custom_reports" ADD CONSTRAINT "custom_reports_check" CHECK (
  "name" = btrim("name") AND "name" <> ''
  AND jsonb_typeof("columns") = 'array' AND jsonb_typeof("filters") = 'array' AND jsonb_typeof("measures") = 'array'
  AND ("group_by" IS NULL OR jsonb_typeof("group_by") = 'object')
  AND ("sort" IS NULL OR jsonb_typeof("sort") = 'object')
  AND "chart" IN ('NONE', 'BAR', 'COLUMN')
  AND ("chart" = 'NONE' OR "group_by" IS NOT NULL)
);
-- 同一用户的报表名称不区分大小写唯一 / report names unique per user, case-insensitive
CREATE UNIQUE INDEX "custom_reports_name_key" ON "custom_reports"("organization_id", "owner_id", lower("name"));
