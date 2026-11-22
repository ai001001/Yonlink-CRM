-- CreateTable
CREATE TABLE "blueprints" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "entity" "workflow_entity" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "transitions" JSONB NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "blueprints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "blueprints_organization_id_entity_idx" ON "blueprints"("organization_id", "entity");

-- AddForeignKey
ALTER TABLE "blueprints" ADD CONSTRAINT "blueprints_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprints" ADD CONSTRAINT "blueprints_organization_id_created_by_id_fkey" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "users"("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;




-- 手工约束 / Hand-written constraints
-- 名称非空白、同组织内不重复（不分大小写、去首尾空格）；转换为 1–20 个的数组；每个对象最多一个启用的蓝图
-- non-blank names unique per organization (case-insensitive, trimmed); 1–20 transitions as an array; one active blueprint per entity
ALTER TABLE "blueprints" ADD CONSTRAINT "blueprints_check" CHECK (
  btrim("name") <> ''
  AND jsonb_typeof("transitions") = 'array' AND jsonb_array_length("transitions") BETWEEN 1 AND 20
);
CREATE UNIQUE INDEX "blueprints_organization_id_name_key" ON "blueprints"("organization_id", lower(btrim("name")));
CREATE UNIQUE INDEX "blueprints_one_active_per_entity" ON "blueprints"("organization_id", "entity") WHERE "is_active";
