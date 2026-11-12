-- CreateEnum
CREATE TYPE "view_entity" AS ENUM ('leads', 'accounts', 'deals', 'activities');

-- CreateTable
CREATE TABLE "saved_views" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "entity" "view_entity" NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "filters" JSONB NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_view_defaults" (
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "entity" "view_entity" NOT NULL,
    "view_id" UUID NOT NULL,

    CONSTRAINT "user_view_defaults_pkey" PRIMARY KEY ("user_id","entity")
);

-- CreateIndex
CREATE INDEX "saved_views_organization_id_entity_shared_idx" ON "saved_views"("organization_id", "entity", "shared");

-- CreateIndex
CREATE UNIQUE INDEX "saved_views_organization_id_id_key" ON "saved_views"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "saved_views_organization_id_owner_id_entity_name_key" ON "saved_views"("organization_id", "owner_id", "entity", "name");

-- CreateIndex
CREATE INDEX "user_view_defaults_organization_id_view_id_idx" ON "user_view_defaults"("organization_id", "view_id");

-- AddForeignKey
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_organization_id_owner_id_fkey" FOREIGN KEY ("organization_id", "owner_id") REFERENCES "users"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_view_defaults" ADD CONSTRAINT "user_view_defaults_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_view_defaults" ADD CONSTRAINT "user_view_defaults_organization_id_user_id_fkey" FOREIGN KEY ("organization_id", "user_id") REFERENCES "users"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_view_defaults" ADD CONSTRAINT "user_view_defaults_organization_id_view_id_fkey" FOREIGN KEY ("organization_id", "view_id") REFERENCES "saved_views"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 业务约束：名称非空 / Business constraint: non-blank names
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_name_non_blank" CHECK (length(btrim("name")) > 0);
-- 筛选条件必须是 JSON 对象 / filters must be a JSON object
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_filters_object" CHECK (jsonb_typeof("filters") = 'object');
