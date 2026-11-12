-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(30) NOT NULL,
    "name_key" VARCHAR(30) NOT NULL,
    "color" VARCHAR(20) NOT NULL DEFAULT 'blue',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_tags" (
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_tags_pkey" PRIMARY KEY ("lead_id","tag_id")
);

-- CreateTable
CREATE TABLE "account_tags" (
    "organization_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_tags_pkey" PRIMARY KEY ("account_id","tag_id")
);

-- CreateTable
CREATE TABLE "deal_tags" (
    "organization_id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_tags_pkey" PRIMARY KEY ("deal_id","tag_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tags_organization_id_id_key" ON "tags"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_organization_id_name_key_key" ON "tags"("organization_id", "name_key");

-- CreateIndex
CREATE INDEX "lead_tags_organization_id_tag_id_idx" ON "lead_tags"("organization_id", "tag_id");

-- CreateIndex
CREATE INDEX "account_tags_organization_id_tag_id_idx" ON "account_tags"("organization_id", "tag_id");

-- CreateIndex
CREATE INDEX "deal_tags_organization_id_tag_id_idx" ON "deal_tags"("organization_id", "tag_id");

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_organization_id_lead_id_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_organization_id_tag_id_fkey" FOREIGN KEY ("organization_id", "tag_id") REFERENCES "tags"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_tags" ADD CONSTRAINT "account_tags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_tags" ADD CONSTRAINT "account_tags_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "accounts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_tags" ADD CONSTRAINT "account_tags_organization_id_tag_id_fkey" FOREIGN KEY ("organization_id", "tag_id") REFERENCES "tags"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_tags" ADD CONSTRAINT "deal_tags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_tags" ADD CONSTRAINT "deal_tags_organization_id_deal_id_fkey" FOREIGN KEY ("organization_id", "deal_id") REFERENCES "deals"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_tags" ADD CONSTRAINT "deal_tags_organization_id_tag_id_fkey" FOREIGN KEY ("organization_id", "tag_id") REFERENCES "tags"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 业务约束：名称非空；name_key 必须等于小写去空格的名称（保证不区分大小写唯一）；颜色来自预设色板
-- Business constraints: non-blank names; name_key = lower(trim(name)) for case-insensitive uniqueness; preset colours
ALTER TABLE "tags" ADD CONSTRAINT "tags_name_non_blank" CHECK (length(btrim("name")) > 0);
ALTER TABLE "tags" ADD CONSTRAINT "tags_name_key_consistent" CHECK ("name_key" = lower(btrim("name")));
ALTER TABLE "tags" ADD CONSTRAINT "tags_color_preset" CHECK ("color" IN ('blue', 'green', 'gold', 'red', 'purple', 'cyan', 'orange', 'magenta', 'geekblue', 'volcano'));
