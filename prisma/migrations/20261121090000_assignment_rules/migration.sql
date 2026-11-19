-- CreateEnum
CREATE TYPE "assignment_entity" AS ENUM ('LEAD');

-- AlterTable
ALTER TABLE "web_forms" ADD COLUMN     "assign_by_rule" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "assignment_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "entity" "assignment_entity" NOT NULL DEFAULT 'LEAD',
    "name" VARCHAR(100) NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "position" INTEGER NOT NULL,
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "assignment_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_rule_users" (
    "organization_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "assignment_rule_users_pkey" PRIMARY KEY ("rule_id","user_id")
);

-- CreateIndex
CREATE INDEX "assignment_rules_organization_id_entity_position_idx" ON "assignment_rules"("organization_id", "entity", "position");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_rules_organization_id_id_key" ON "assignment_rules"("organization_id", "id");

-- CreateIndex
CREATE INDEX "assignment_rule_users_organization_id_user_id_idx" ON "assignment_rule_users"("organization_id", "user_id");

-- AddForeignKey
ALTER TABLE "assignment_rules" ADD CONSTRAINT "assignment_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_rule_users" ADD CONSTRAINT "assignment_rule_users_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_rule_users" ADD CONSTRAINT "assignment_rule_users_organization_id_rule_id_fkey" FOREIGN KEY ("organization_id", "rule_id") REFERENCES "assignment_rules"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_rule_users" ADD CONSTRAINT "assignment_rule_users_organization_id_user_id_fkey" FOREIGN KEY ("organization_id", "user_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;



-- 手工约束 / Hand-written constraints
-- 规则名称非空白；顺序、轮转指针非负；条件为数组且最多 5 条；负责人顺序非负
-- non-blank names; non-negative position and cursor; conditions are an array of at most 5; non-negative user position
ALTER TABLE "assignment_rules" ADD CONSTRAINT "assignment_rules_check" CHECK (
  btrim("name") <> '' AND "position" >= 0 AND "cursor" >= 0
  AND jsonb_typeof("conditions") = 'array' AND jsonb_array_length("conditions") <= 5
);
ALTER TABLE "assignment_rule_users" ADD CONSTRAINT "assignment_rule_users_check" CHECK ("position" >= 0);

-- 网页表单：按规则分配与固定负责人互斥 / web forms: rule assignment and a fixed owner are exclusive
ALTER TABLE "web_forms" ADD CONSTRAINT "web_forms_assign_check" CHECK (NOT ("assign_by_rule" AND "owner_id" IS NOT NULL));
