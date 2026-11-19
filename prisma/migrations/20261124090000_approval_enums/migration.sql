-- 只新增枚举值（与使用分开）/ add enum values only (kept apart from their use)
ALTER TYPE "notification_type" ADD VALUE 'APPROVAL_REQUEST';
ALTER TYPE "notification_type" ADD VALUE 'APPROVAL_DECIDED';
