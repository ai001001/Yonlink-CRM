-- 工作流规则支持客户与服务工单；宏、流程蓝图、销售节奏、验证规则仍只用于线索与商机（数据库兜底）
-- Workflow rules cover accounts and tickets; macros, blueprints, cadences and validation rules stay lead/deal only (enforced in the database too)
ALTER TABLE "macros" ADD CONSTRAINT "macros_entity_check" CHECK ("entity" IN ('LEAD', 'DEAL'));
ALTER TABLE "blueprints" ADD CONSTRAINT "blueprints_entity_check" CHECK ("entity" IN ('LEAD', 'DEAL'));
ALTER TABLE "cadences" ADD CONSTRAINT "cadences_entity_check" CHECK ("entity" IN ('LEAD', 'DEAL'));
ALTER TABLE "validation_rules" ADD CONSTRAINT "validation_rules_entity_check" CHECK ("entity" IN ('LEAD', 'DEAL'));
-- 服务工单没有跟进记录，不能用“无跟进”触发 / tickets have no activities, so no inactivity trigger
ALTER TABLE "workflow_rules" ADD CONSTRAINT "workflow_rules_entity_trigger_check" CHECK (NOT ("entity" = 'TICKET' AND "trigger" = 'INACTIVITY'));
