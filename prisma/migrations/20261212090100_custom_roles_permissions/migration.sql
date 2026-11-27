-- 修正：上一个迁移的可授予权限目录漏掉了 data.export（生成约束时的提取错误），按完整目录重建约束
-- fix: the previous migration's grantable catalogue missed data.export (an extraction error); rebuild the constraint
ALTER TABLE "custom_roles" DROP CONSTRAINT "custom_roles_check";
ALTER TABLE "custom_roles" ADD CONSTRAINT "custom_roles_check" CHECK (
  "name" = btrim("name") AND "name" <> ''
  AND "base_role" <> 'ADMIN'
  AND "permissions" <@ ARRAY['record.read.all', 'record.create', 'record.update.all', 'record.update.own', 'record.delete', 'owner.assign', 'audit.read', 'product.manage', 'tag.manage', 'recycle.purge', 'view.share', 'forecast.manage', 'campaign.manage', 'sla.manage', 'scoring.manage', 'assignment.manage', 'workflow.manage', 'approval.manage', 'quote.approve', 'validation.manage', 'customfield.manage', 'portal.manage', 'cadence.manage', 'blueprint.manage', 'macro.manage', 'territory.manage', 'purchase.read', 'purchase.manage', 'kb.manage', 'rate.manage', 'data.export']::text[]
);
