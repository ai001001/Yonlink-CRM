-- AlterTable
ALTER TABLE "users" ADD COLUMN     "custom_role_id" UUID;

-- CreateTable
CREATE TABLE "custom_roles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "description" VARCHAR(500),
    "base_role" "user_role" NOT NULL,
    "permissions" TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "custom_roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "custom_roles_organization_id_id_key" ON "custom_roles"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_custom_role_id_fkey" FOREIGN KEY ("organization_id", "custom_role_id") REFERENCES "custom_roles"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "custom_roles" ADD CONSTRAINT "custom_roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 名称去空白且非空、组织内不区分大小写唯一；基础角色不能是系统管理员；权限只能取可授予的目录
-- （“用户管理”“集成管理”只属于系统管理员，不能授予自定义角色；新增权限时需同步本约束）
-- trimmed unique names; the base role is never ADMIN; permissions come from the grantable catalogue (user and integration
-- management stay with system administrators; update this constraint when permissions are added)
ALTER TABLE "custom_roles" ADD CONSTRAINT "custom_roles_check" CHECK (
  "name" = btrim("name") AND "name" <> ''
  AND "base_role" <> 'ADMIN'
  AND "permissions" <@ ARRAY['record.read.all', 'record.create', 'record.update.all', 'record.update.own', 'record.delete', 'owner.assign', 'audit.read', 'product.manage', 'tag.manage', 'recycle.purge', 'view.share', 'forecast.manage', 'campaign.manage', 'sla.manage', 'scoring.manage', 'assignment.manage', 'workflow.manage', 'approval.manage', 'quote.approve', 'validation.manage', 'customfield.manage', 'portal.manage', 'cadence.manage', 'blueprint.manage', 'macro.manage', 'territory.manage', 'purchase.read', 'purchase.manage', 'kb.manage', 'rate.manage']::text[]
);
CREATE UNIQUE INDEX "custom_roles_name_key" ON "custom_roles"("organization_id", lower("name"));

-- 系统管理员不能套用自定义角色（避免管理员失去管理权限）/ admins never carry a custom role (no admin lockout)
ALTER TABLE "users" ADD CONSTRAINT "users_custom_role_check" CHECK (NOT ("role" = 'ADMIN' AND "custom_role_id" IS NOT NULL));
