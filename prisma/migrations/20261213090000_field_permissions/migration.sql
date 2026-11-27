-- CreateEnum
CREATE TYPE "field_access" AS ENUM ('HIDDEN', 'READ_ONLY');

-- CreateTable
CREATE TABLE "field_permissions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "entity" "custom_entity" NOT NULL,
    "field" VARCHAR(40) NOT NULL,
    "role" "user_role",
    "custom_role_id" UUID,
    "access" "field_access" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "field_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "field_permissions_organization_id_role_idx" ON "field_permissions"("organization_id", "role");

-- CreateIndex
CREATE INDEX "field_permissions_organization_id_custom_role_id_idx" ON "field_permissions"("organization_id", "custom_role_id");

-- AddForeignKey
ALTER TABLE "field_permissions" ADD CONSTRAINT "field_permissions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_permissions" ADD CONSTRAINT "field_permissions_organization_id_custom_role_id_fkey" FOREIGN KEY ("organization_id", "custom_role_id") REFERENCES "custom_roles"("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;


-- 二选一：系统角色（不能是系统管理员）或自定义角色；字段取自可限制的标准字段，或 custom.<自定义字段键>
-- （新增可限制的标准字段时需同步本约束与应用中的目录）
-- exactly one of a system role (never ADMIN) or a custom role; fields come from the restrictable standard fields or
-- custom.<custom field key> (update this constraint together with the application catalogue)
ALTER TABLE "field_permissions" ADD CONSTRAINT "field_permissions_check" CHECK (
  num_nonnulls("role", "custom_role_id") = 1
  AND ("role" IS NULL OR "role" <> 'ADMIN')
  AND (
    "field" ~ '^custom\.cf_[a-z0-9]{8}$'
    OR ("entity" = 'LEAD' AND "field" IN ('title', 'phone', 'mobile', 'email', 'description'))
    OR ("entity" = 'ACCOUNT' AND "field" IN ('phone', 'website', 'address', 'description'))
    OR ("entity" = 'CONTACT' AND "field" IN ('title', 'phone', 'email'))
    OR ("entity" = 'DEAL' AND "field" IN ('description'))
  )
);
-- 每个角色每个字段一条 / one row per role and field
CREATE UNIQUE INDEX "field_permissions_role_key" ON "field_permissions"("organization_id", "entity", "field", "role") WHERE "role" IS NOT NULL;
CREATE UNIQUE INDEX "field_permissions_custom_role_key" ON "field_permissions"("organization_id", "entity", "field", "custom_role_id") WHERE "custom_role_id" IS NOT NULL;
