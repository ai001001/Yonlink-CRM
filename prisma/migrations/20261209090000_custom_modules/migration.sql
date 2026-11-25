-- CreateTable
CREATE TABLE "custom_modules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "description" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "custom_modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_module_fields" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "module_id" UUID NOT NULL,
    "key" VARCHAR(30) NOT NULL,
    "label" VARCHAR(50) NOT NULL,
    "type" "custom_field_type" NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "custom_module_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_records" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "module_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "owner_id" UUID,
    "account_id" UUID,
    "values" JSONB NOT NULL DEFAULT '{}',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "custom_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_modules_organization_id_position_idx" ON "custom_modules"("organization_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "custom_modules_organization_id_id_key" ON "custom_modules"("organization_id", "id");

-- CreateIndex
CREATE INDEX "custom_module_fields_organization_id_module_id_position_idx" ON "custom_module_fields"("organization_id", "module_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "custom_module_fields_module_id_key_key" ON "custom_module_fields"("module_id", "key");

-- CreateIndex
CREATE INDEX "custom_records_organization_id_module_id_created_at_idx" ON "custom_records"("organization_id", "module_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "custom_records_organization_id_account_id_idx" ON "custom_records"("organization_id", "account_id");

-- CreateIndex
CREATE INDEX "custom_records_organization_id_owner_id_idx" ON "custom_records"("organization_id", "owner_id");

-- AddForeignKey
ALTER TABLE "custom_modules" ADD CONSTRAINT "custom_modules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_modules" ADD CONSTRAINT "custom_modules_organization_id_created_by_id_fkey" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "custom_module_fields" ADD CONSTRAINT "custom_module_fields_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_module_fields" ADD CONSTRAINT "custom_module_fields_organization_id_module_id_fkey" FOREIGN KEY ("organization_id", "module_id") REFERENCES "custom_modules"("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "custom_records" ADD CONSTRAINT "custom_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_records" ADD CONSTRAINT "custom_records_organization_id_module_id_fkey" FOREIGN KEY ("organization_id", "module_id") REFERENCES "custom_modules"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "custom_records" ADD CONSTRAINT "custom_records_organization_id_owner_id_fkey" FOREIGN KEY ("organization_id", "owner_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "custom_records" ADD CONSTRAINT "custom_records_organization_id_created_by_id_fkey" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "custom_records" ADD CONSTRAINT "custom_records_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "accounts"("organization_id", "id") ON DELETE SET NULL ("account_id") ON UPDATE NO ACTION;


-- 手工修改：上方 custom_records 的 SET NULL 只置空 account_id（不能置空 organization_id）
-- hand edit: the SET NULL above clears account_id only (organization_id must stay)

-- 名称去空白且非空；位置非负 / trimmed non-empty names; non-negative positions
ALTER TABLE "custom_modules" ADD CONSTRAINT "custom_modules_check" CHECK ("name" = btrim("name") AND "name" <> '' AND "position" >= 0);
CREATE UNIQUE INDEX "custom_modules_name_key" ON "custom_modules"("organization_id", lower("name"));

-- 字段键由服务端生成；勾选不能必填；选项为数组 / server-generated keys; checkboxes cannot be required; options are an array
ALTER TABLE "custom_module_fields" ADD CONSTRAINT "custom_module_fields_check" CHECK (
  "key" ~ '^cf_[0-9a-f]{8}$'
  AND "label" = btrim("label") AND "label" <> ''
  AND jsonb_typeof("options") = 'array'
  AND NOT ("type" = 'CHECKBOX' AND "required")
  AND "position" >= 0
);
CREATE UNIQUE INDEX "custom_module_fields_label_key" ON "custom_module_fields"("module_id", lower("label"));

-- 记录名称非空；值为对象 / non-empty record names; values are an object
ALTER TABLE "custom_records" ADD CONSTRAINT "custom_records_check" CHECK ("name" = btrim("name") AND "name" <> '' AND jsonb_typeof("values") = 'object');
