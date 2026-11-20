-- CreateTable
CREATE TABLE "validation_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "entity" "workflow_entity" NOT NULL,
    "when" JSONB NOT NULL DEFAULT '[]',
    "require" JSONB NOT NULL,
    "message" VARCHAR(200) NOT NULL,
    "error_field" VARCHAR(30),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "validation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "validation_rules_organization_id_entity_is_active_idx" ON "validation_rules"("organization_id", "entity", "is_active");

-- AddForeignKey
ALTER TABLE "validation_rules" ADD CONSTRAINT "validation_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_rules" ADD CONSTRAINT "validation_rules_organization_id_created_by_id_fkey" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;



-- 手工约束 / Hand-written constraints
-- 名称组织内唯一（不区分大小写）、非空白；提示非空白；适用条件为数组且最多 5 条；要求 1–5 条
-- unique case-insensitive non-blank names; non-blank messages; "when" is an array of at most 5; "require" has 1–5
CREATE UNIQUE INDEX "validation_rules_name_key" ON "validation_rules"("organization_id", lower("name"));
ALTER TABLE "validation_rules" ADD CONSTRAINT "validation_rules_check" CHECK (
  btrim("name") <> '' AND btrim("message") <> ''
  AND jsonb_typeof("when") = 'array' AND jsonb_array_length("when") <= 5
  AND jsonb_typeof("require") = 'array' AND jsonb_array_length("require") BETWEEN 1 AND 5
);
