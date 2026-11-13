-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID,
    "account_id" UUID,
    "deal_id" UUID,
    "file_name" VARCHAR(200) NOT NULL,
    "content_type" VARCHAR(100) NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attachments_organization_id_lead_id_created_at_idx" ON "attachments"("organization_id", "lead_id", "created_at");

-- CreateIndex
CREATE INDEX "attachments_organization_id_account_id_created_at_idx" ON "attachments"("organization_id", "account_id", "created_at");

-- CreateIndex
CREATE INDEX "attachments_organization_id_deal_id_created_at_idx" ON "attachments"("organization_id", "deal_id", "created_at");

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organization_id_uploaded_by_id_fkey" FOREIGN KEY ("organization_id", "uploaded_by_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organization_id_lead_id_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "accounts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organization_id_deal_id_fkey" FOREIGN KEY ("organization_id", "deal_id") REFERENCES "deals"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 业务约束 / Business constraints
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_exactly_one_parent" CHECK (num_nonnulls("lead_id", "account_id", "deal_id") = 1);
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_size_range" CHECK ("size" > 0 AND "size" <= 10485760);
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_name_non_blank" CHECK (length(btrim("file_name")) > 0);
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_sha256_hex" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
