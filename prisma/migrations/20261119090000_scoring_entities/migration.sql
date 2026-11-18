-- 评分规则从“仅线索”扩展到线索、客户、联系人：重命名表、类型与约束（保留已有规则数据），增加对象列与新规则类型。
-- 手工编写：Prisma 自动生成的差异会删表重建并丢失已部署的规则。新枚举值在本迁移中只添加不使用（同一事务内不能使用），
-- 约束与函数在下一个迁移中定义。
-- Scoring rules go from leads only to leads, accounts and contacts: rename tables, types and constraints (keeping existing
-- rules), add the entity column and a new rule kind. Hand-written: Prisma's generated diff would drop and recreate the
-- tables and lose deployed rules. The new enum value is only added here (it cannot be used in the same transaction);
-- constraints and functions are defined in the next migration.

-- CreateEnum
CREATE TYPE "scoring_entity" AS ENUM ('LEAD', 'ACCOUNT', 'CONTACT');

-- 规则类型改名并新增“关联记录数” / rename the kind type and add RELATED_COUNT
ALTER TYPE "lead_scoring_rule_kind" RENAME TO "scoring_rule_kind";
ALTER TYPE "scoring_rule_kind" ADD VALUE 'RELATED_COUNT';

-- 规则表 / rules table
ALTER TABLE "lead_scoring_rules" RENAME TO "scoring_rules";
ALTER TABLE "scoring_rules" RENAME CONSTRAINT "lead_scoring_rules_pkey" TO "scoring_rules_pkey";
ALTER TABLE "scoring_rules" RENAME CONSTRAINT "lead_scoring_rules_organization_id_fkey" TO "scoring_rules_organization_id_fkey";
-- 旧约束只适用于线索，下一个迁移按对象重建 / the old check covers leads only; rebuilt per entity in the next migration
ALTER TABLE "scoring_rules" DROP CONSTRAINT "lead_scoring_rules_check";
ALTER INDEX "lead_scoring_rules_organization_id_id_key" RENAME TO "scoring_rules_organization_id_id_key";
DROP INDEX "lead_scoring_rules_organization_id_position_idx";
ALTER TABLE "scoring_rules" ADD COLUMN "entity" "scoring_entity" NOT NULL DEFAULT 'LEAD';
CREATE INDEX "scoring_rules_organization_id_entity_position_idx" ON "scoring_rules"("organization_id", "entity", "position");

-- 阈值表：主键改为（组织, 对象）/ settings table: primary key becomes (organization, entity)
ALTER TABLE "lead_scoring_settings" RENAME TO "scoring_settings";
ALTER TABLE "scoring_settings" RENAME CONSTRAINT "lead_scoring_settings_organization_id_fkey" TO "scoring_settings_organization_id_fkey";
ALTER TABLE "scoring_settings" RENAME CONSTRAINT "lead_scoring_settings_check" TO "scoring_settings_check";
ALTER TABLE "scoring_settings" DROP CONSTRAINT "lead_scoring_settings_pkey";
ALTER TABLE "scoring_settings" ADD COLUMN "entity" "scoring_entity" NOT NULL DEFAULT 'LEAD';
ALTER TABLE "scoring_settings" ADD CONSTRAINT "scoring_settings_pkey" PRIMARY KEY ("organization_id", "entity");
