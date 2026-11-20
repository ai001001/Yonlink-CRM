-- AlterTable
ALTER TABLE "workflow_rules" ADD COLUMN     "trigger_days" INTEGER;

-- CreateTable
CREATE TABLE "workflow_schedule_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "ran_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_schedule_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workflow_schedule_runs_rule_id_record_id_key_key" ON "workflow_schedule_runs"("rule_id", "record_id", "key");

-- AddForeignKey
ALTER TABLE "workflow_schedule_runs" ADD CONSTRAINT "workflow_schedule_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_schedule_runs" ADD CONSTRAINT "workflow_schedule_runs_organization_id_rule_id_fkey" FOREIGN KEY ("organization_id", "rule_id") REFERENCES "workflow_rules"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;



-- 手工约束 / Hand-written constraints
-- 触发字段：字段变化与相对日期必须有、其他不能有；天数：相对日期 −365–365，无跟进 1–365，其他不能有；执行键非空白
-- trigger field required exactly for FIELD_CHANGE and DATE_RELATIVE; days −365..365 for DATE_RELATIVE, 1..365 for
-- INACTIVITY, otherwise null; non-blank run keys
ALTER TABLE "workflow_rules" DROP CONSTRAINT "workflow_rules_check";
ALTER TABLE "workflow_rules" ADD CONSTRAINT "workflow_rules_check" CHECK (
  btrim("name") <> ''
  AND (("trigger" IN ('FIELD_CHANGE', 'DATE_RELATIVE')) = ("trigger_field" IS NOT NULL))
  AND (
    ("trigger" = 'DATE_RELATIVE' AND "trigger_days" BETWEEN -365 AND 365)
    OR ("trigger" = 'INACTIVITY' AND "trigger_days" BETWEEN 1 AND 365)
    OR ("trigger" NOT IN ('DATE_RELATIVE', 'INACTIVITY') AND "trigger_days" IS NULL)
  )
  AND jsonb_typeof("conditions") = 'array' AND jsonb_array_length("conditions") <= 5
  AND jsonb_typeof("actions") = 'array' AND jsonb_array_length("actions") BETWEEN 1 AND 5
  AND "run_count" >= 0
);
ALTER TABLE "workflow_schedule_runs" ADD CONSTRAINT "workflow_schedule_runs_check" CHECK (btrim("key") <> '');
