-- CreateEnum
CREATE TYPE "workflow_entity" AS ENUM ('LEAD', 'DEAL');

-- CreateEnum
CREATE TYPE "workflow_trigger" AS ENUM ('CREATE', 'UPDATE', 'CREATE_OR_UPDATE', 'FIELD_CHANGE');

-- CreateTable
CREATE TABLE "workflow_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "entity" "workflow_entity" NOT NULL,
    "trigger" "workflow_trigger" NOT NULL,
    "trigger_field" VARCHAR(30),
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "actions" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "last_run_at" TIMESTAMPTZ(6),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_rules_organization_id_entity_is_active_idx" ON "workflow_rules"("organization_id", "entity", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_rules_organization_id_id_key" ON "workflow_rules"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "workflow_rules" ADD CONSTRAINT "workflow_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_rules" ADD CONSTRAINT "workflow_rules_organization_id_created_by_id_fkey" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;



-- 手工约束 / Hand-written constraints
-- 名称组织内唯一（不区分大小写）、非空白；字段变化触发必须指定字段（且只在此时指定）；条件为数组且最多 5 条；动作为 1–5 条；执行次数非负
-- unique case-insensitive non-blank names; trigger_field set exactly for FIELD_CHANGE; conditions an array of at most 5;
-- 1–5 actions; non-negative run count
CREATE UNIQUE INDEX "workflow_rules_name_key" ON "workflow_rules"("organization_id", lower("name"));
ALTER TABLE "workflow_rules" ADD CONSTRAINT "workflow_rules_check" CHECK (
  btrim("name") <> ''
  AND (("trigger" = 'FIELD_CHANGE') = ("trigger_field" IS NOT NULL))
  AND jsonb_typeof("conditions") = 'array' AND jsonb_array_length("conditions") <= 5
  AND jsonb_typeof("actions") = 'array' AND jsonb_array_length("actions") BETWEEN 1 AND 5
  AND "run_count" >= 0
);
