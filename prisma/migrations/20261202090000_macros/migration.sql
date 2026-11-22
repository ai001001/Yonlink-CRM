-- CreateEnum
CREATE TYPE "macro_scope" AS ENUM ('PERSONAL', 'SHARED');

-- CreateTable
CREATE TABLE "macros" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "entity" "workflow_entity" NOT NULL,
    "scope" "macro_scope" NOT NULL,
    "actions" JSONB NOT NULL,
    "created_by_id" UUID NOT NULL,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "last_run_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "macros_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "macros_organization_id_entity_idx" ON "macros"("organization_id", "entity");

-- CreateIndex
CREATE INDEX "macros_organization_id_created_by_id_idx" ON "macros"("organization_id", "created_by_id");

-- AddForeignKey
ALTER TABLE "macros" ADD CONSTRAINT "macros_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "macros" ADD CONSTRAINT "macros_organization_id_created_by_id_fkey" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "users"("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;




-- 手工约束 / Hand-written constraints
-- 名称非空白、同组织内不重复（不分大小写、去首尾空格）；动作为 1–5 个的数组；执行次数非负
-- non-blank names unique per organization (case-insensitive, trimmed); 1–5 actions as an array; non-negative run count
ALTER TABLE "macros" ADD CONSTRAINT "macros_check" CHECK (
  btrim("name") <> ''
  AND jsonb_typeof("actions") = 'array' AND jsonb_array_length("actions") BETWEEN 1 AND 5
  AND "run_count" >= 0
);
CREATE UNIQUE INDEX "macros_organization_id_name_key" ON "macros"("organization_id", lower(btrim("name")));
