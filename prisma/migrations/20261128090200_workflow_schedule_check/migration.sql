-- 修正：定时触发的天数为空时，BETWEEN 的结果为“未知”，CHECK 会把“未知”当作通过；显式要求不为空。
-- Fix: with NULL days, BETWEEN yields unknown and CHECK treats unknown as passing; require NOT NULL explicitly.
ALTER TABLE "workflow_rules" DROP CONSTRAINT "workflow_rules_check";
ALTER TABLE "workflow_rules" ADD CONSTRAINT "workflow_rules_check" CHECK (
  btrim("name") <> ''
  AND (("trigger" IN ('FIELD_CHANGE', 'DATE_RELATIVE')) = ("trigger_field" IS NOT NULL))
  AND (
    ("trigger" = 'DATE_RELATIVE' AND "trigger_days" IS NOT NULL AND "trigger_days" BETWEEN -365 AND 365)
    OR ("trigger" = 'INACTIVITY' AND "trigger_days" IS NOT NULL AND "trigger_days" BETWEEN 1 AND 365)
    OR ("trigger" NOT IN ('DATE_RELATIVE', 'INACTIVITY') AND "trigger_days" IS NULL)
  )
  AND jsonb_typeof("conditions") = 'array' AND jsonb_array_length("conditions") <= 5
  AND jsonb_typeof("actions") = 'array' AND jsonb_array_length("actions") BETWEEN 1 AND 5
  AND "run_count" >= 0
);
