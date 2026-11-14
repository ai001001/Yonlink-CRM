-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('BANK_TRANSFER', 'CASH', 'CHECK', 'CARD', 'OTHER');

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "invoice_number" VARCHAR(30) NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "status" "invoice_status" NOT NULL DEFAULT 'UNPAID',
    "currency" CHAR(3) NOT NULL,
    "tax_percent" DECIMAL(5,2) NOT NULL,
    "subtotal" DECIMAL(18,2) NOT NULL,
    "tax_amount" DECIMAL(18,2) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "paid_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "invoice_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "billing_address" VARCHAR(500),
    "notes" TEXT,
    "void_reason" VARCHAR(500),
    "created_by_id" UUID,
    "paid_at" TIMESTAMPTZ(6),
    "voided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "product_sku" VARCHAR(50) NOT NULL,
    "product_name" VARCHAR(200) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "quantity" DECIMAL(18,2) NOT NULL,
    "unit_price" DECIMAL(18,2) NOT NULL,
    "discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_payments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "paid_on" DATE NOT NULL,
    "method" "payment_method" NOT NULL,
    "reference" VARCHAR(100),
    "recorded_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoices_organization_id_deal_id_idx" ON "invoices"("organization_id", "deal_id");

-- CreateIndex
CREATE INDEX "invoices_organization_id_sales_order_id_idx" ON "invoices"("organization_id", "sales_order_id");

-- CreateIndex
CREATE INDEX "invoices_organization_id_created_at_idx" ON "invoices"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "invoices_organization_id_status_due_date_idx" ON "invoices"("organization_id", "status", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_organization_id_id_key" ON "invoices"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_organization_id_invoice_number_key" ON "invoices"("organization_id", "invoice_number");

-- CreateIndex
CREATE INDEX "invoice_line_items_organization_id_invoice_id_idx" ON "invoice_line_items"("organization_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_line_items_invoice_id_position_key" ON "invoice_line_items"("invoice_id", "position");

-- CreateIndex
CREATE INDEX "invoice_payments_organization_id_invoice_id_paid_on_idx" ON "invoice_payments"("organization_id", "invoice_id", "paid_on");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_sales_order_id_fkey" FOREIGN KEY ("organization_id", "sales_order_id") REFERENCES "sales_orders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_deal_id_fkey" FOREIGN KEY ("organization_id", "deal_id") REFERENCES "deals"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_created_by_id_fkey" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_organization_id_invoice_id_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "invoices"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_organization_id_invoice_id_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "invoices"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_organization_id_recorded_by_id_fkey" FOREIGN KEY ("organization_id", "recorded_by_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- 同一订单只能有一张未作废的发票 / one non-void invoice per order
CREATE UNIQUE INDEX "invoices_active_order_key" ON "invoices"("organization_id", "sales_order_id") WHERE "status" <> 'VOID';

-- 金额、日期与状态一致性 / amount, date and status consistency
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_total_check" CHECK ("total" = "subtotal" + "tax_amount" AND "subtotal" >= 0 AND "tax_amount" >= 0);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tax_percent_check" CHECK ("tax_percent" >= 0 AND "tax_percent" <= 100);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_dates_check" CHECK ("due_date" >= "invoice_date");
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_paid_check" CHECK ("paid_amount" >= 0 AND "paid_amount" <= "total");
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_status_check" CHECK (
  CASE "status"
    WHEN 'VOID' THEN "paid_amount" = 0
    WHEN 'PAID' THEN "paid_amount" = "total"
    WHEN 'PARTIALLY_PAID' THEN "paid_amount" > 0 AND "paid_amount" < "total"
    ELSE "paid_amount" = 0 AND "total" > 0
  END
);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_paid_at_check" CHECK (("status" = 'PAID') = ("paid_at" IS NOT NULL));
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_voided_at_check" CHECK (("status" = 'VOID') = ("voided_at" IS NOT NULL));
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_amount_check" CHECK ("quantity" > 0 AND "unit_price" >= 0 AND "discount_percent" >= 0 AND "discount_percent" <= 100 AND "line_total" >= 0);
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_amount_check" CHECK ("amount" > 0);
