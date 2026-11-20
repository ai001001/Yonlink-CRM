-- 只新增枚举值（与使用分开）/ add enum values only (kept apart from their use)
ALTER TYPE "workflow_trigger" ADD VALUE 'DATE_RELATIVE';
ALTER TYPE "workflow_trigger" ADD VALUE 'INACTIVITY';
