-- 商机评分：新增评分对象 DEAL 与规则类型 AMOUNT_AT_LEAST。新枚举值在本迁移中只添加不使用（同一事务内不能使用），
-- 约束、函数与触发器在下一个迁移中定义。
-- Deal scoring: add the DEAL entity and the AMOUNT_AT_LEAST rule kind. The new enum values are only added here (they
-- cannot be used in the same transaction); constraints, functions and triggers follow in the next migration.

-- AlterEnum
ALTER TYPE "scoring_entity" ADD VALUE 'DEAL';

-- AlterEnum
ALTER TYPE "scoring_rule_kind" ADD VALUE 'AMOUNT_AT_LEAST';
