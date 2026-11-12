-- CreateEnum
CREATE TYPE "quote_status" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED');

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "quote_number" VARCHAR(30) NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "status" "quote_status" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL,
    "valid_until" DATE,
    "tax_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(18,2) NOT NULL,
    "tax_amount" DECIMAL(18,2) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "terms" TEXT,
    "notes" TEXT,
    "created_by_id" UUID,
    "sent_at" TIMESTAMPTZ(6),
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_line_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "product_sku" VARCHAR(50) NOT NULL,
    "product_name" VARCHAR(200) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "quantity" DECIMAL(18,2) NOT NULL,
    "unit_price" DECIMAL(18,2) NOT NULL,
    "discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "quote_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quotes_organization_id_deal_id_idx" ON "quotes"("organization_id", "deal_id");

-- CreateIndex
CREATE INDEX "quotes_organization_id_created_at_idx" ON "quotes"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "quotes_organization_id_status_idx" ON "quotes"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_organization_id_id_key" ON "quotes"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_organization_id_quote_number_key" ON "quotes"("organization_id", "quote_number");

-- CreateIndex
CREATE UNIQUE INDEX "quote_line_items_organization_id_quote_id_position_key" ON "quote_line_items"("organization_id", "quote_id", "position");

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_organization_id_deal_id_fkey" FOREIGN KEY ("organization_id", "deal_id") REFERENCES "deals"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_organization_id_created_by_id_fkey" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quote_line_items" ADD CONSTRAINT "quote_line_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_line_items" ADD CONSTRAINT "quote_line_items_organization_id_quote_id_fkey" FOREIGN KEY ("organization_id", "quote_id") REFERENCES "quotes"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 业务约束 / Business constraints
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_number_non_blank" CHECK (length(btrim("quote_number")) > 0);
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_subject_non_blank" CHECK (length(btrim("subject")) > 0);
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_tax_range" CHECK ("tax_percent" >= 0 AND "tax_percent" <= 100);
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_amounts_non_negative" CHECK ("subtotal" >= 0 AND "tax_amount" >= 0 AND "total" >= 0);
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_total_consistent" CHECK ("total" = "subtotal" + "tax_amount");
ALTER TABLE "quote_line_items" ADD CONSTRAINT "quote_line_items_position_positive" CHECK ("position" > 0);
ALTER TABLE "quote_line_items" ADD CONSTRAINT "quote_line_items_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "quote_line_items" ADD CONSTRAINT "quote_line_items_unit_price_non_negative" CHECK ("unit_price" >= 0);
ALTER TABLE "quote_line_items" ADD CONSTRAINT "quote_line_items_discount_range" CHECK ("discount_percent" >= 0 AND "discount_percent" <= 100);
ALTER TABLE "quote_line_items" ADD CONSTRAINT "quote_line_items_total_non_negative" CHECK ("line_total" >= 0);
