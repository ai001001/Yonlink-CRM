-- CreateTable
CREATE TABLE "notes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "lead_id" UUID,
    "account_id" UUID,
    "deal_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notes_organization_id_lead_id_created_at_idx" ON "notes"("organization_id", "lead_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notes_organization_id_account_id_created_at_idx" ON "notes"("organization_id", "account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notes_organization_id_deal_id_created_at_idx" ON "notes"("organization_id", "deal_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_organization_id_author_id_fkey" FOREIGN KEY ("organization_id", "author_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_organization_id_lead_id_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "accounts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_organization_id_deal_id_fkey" FOREIGN KEY ("organization_id", "deal_id") REFERENCES "deals"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 每条备注恰好属于一条线索、客户或商机 / each note belongs to exactly one lead, account or deal
ALTER TABLE "notes" ADD CONSTRAINT "notes_exactly_one_parent" CHECK (num_nonnulls("lead_id", "account_id", "deal_id") = 1);
-- 内容不能为空白，长度上限与接口一致 / content is non-blank and within the API limit
ALTER TABLE "notes" ADD CONSTRAINT "notes_content_valid" CHECK (length(btrim("content")) > 0 AND length("content") <= 5000);
