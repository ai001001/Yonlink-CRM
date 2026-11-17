-- CreateEnum
CREATE TYPE "purchase_order_status" AS ENUM ('DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "document_counters" (
    "organization_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "year" INTEGER NOT NULL,
    "last" INTEGER NOT NULL,

    CONSTRAINT "document_counters_pkey" PRIMARY KEY ("organization_id","kind","year")
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "contact_name" VARCHAR(100),
    "phone" VARCHAR(50),
    "email" VARCHAR(254),
    "website" VARCHAR(200),
    "address" VARCHAR(500),
    "currency" CHAR(3) NOT NULL DEFAULT 'CNY',
    "payment_terms" VARCHAR(100),
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "po_number" VARCHAR(30) NOT NULL,
    "vendor_id" UUID NOT NULL,
    "sales_order_id" UUID,
    "subject" VARCHAR(200) NOT NULL,
    "status" "purchase_order_status" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL,
    "tax_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "exchange_rate" DECIMAL(18,8),
    "base_total" DECIMAL(18,2),
    "expected_date" DATE,
    "delivery_address" VARCHAR(500),
    "notes" TEXT,
    "cancel_reason" VARCHAR(500),
    "created_by_id" UUID,
    "ordered_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_line_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "product_sku" VARCHAR(50) NOT NULL,
    "product_name" VARCHAR(200) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "quantity" DECIMAL(18,2) NOT NULL,
    "received_quantity" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "unit_cost" DECIMAL(18,2) NOT NULL,
    "line_total" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "purchase_order_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vendors_organization_id_is_active_idx" ON "vendors"("organization_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_organization_id_id_key" ON "vendors"("organization_id", "id");

-- CreateIndex
CREATE INDEX "purchase_orders_organization_id_vendor_id_idx" ON "purchase_orders"("organization_id", "vendor_id");

-- CreateIndex
CREATE INDEX "purchase_orders_organization_id_status_idx" ON "purchase_orders"("organization_id", "status");

-- CreateIndex
CREATE INDEX "purchase_orders_organization_id_sales_order_id_idx" ON "purchase_orders"("organization_id", "sales_order_id");

-- CreateIndex
CREATE INDEX "purchase_orders_organization_id_created_at_idx" ON "purchase_orders"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_organization_id_id_key" ON "purchase_orders"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_organization_id_po_number_key" ON "purchase_orders"("organization_id", "po_number");

-- CreateIndex
CREATE INDEX "purchase_order_line_items_organization_id_purchase_order_id_idx" ON "purchase_order_line_items"("organization_id", "purchase_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_line_items_purchase_order_id_position_key" ON "purchase_order_line_items"("purchase_order_id", "position");

-- AddForeignKey
ALTER TABLE "document_counters" ADD CONSTRAINT "document_counters_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_vendor_id_fkey" FOREIGN KEY ("organization_id", "vendor_id") REFERENCES "vendors"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_sales_order_id_fkey" FOREIGN KEY ("organization_id", "sales_order_id") REFERENCES "sales_orders"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_created_by_id_fkey" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "purchase_order_line_items" ADD CONSTRAINT "purchase_order_line_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_line_items" ADD CONSTRAINT "purchase_order_line_items_organization_id_purchase_order_i_fkey" FOREIGN KEY ("organization_id", "purchase_order_id") REFERENCES "purchase_orders"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 手工约束 / Hand-written constraints
-- 供应商：名称组织内唯一（不区分大小写）、非空白；币种代码 / vendors: unique case-insensitive non-blank names; currency code
CREATE UNIQUE INDEX "vendors_name_key" ON "vendors"("organization_id", lower("name"));
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_check" CHECK (btrim("name") <> '' AND "currency" ~ '^[A-Z]{3}$');
-- 采购单：金额非负、税率 0–100、币种代码、主题非空白；状态与时间一致 / amounts, tax, currency, subject; status timestamps
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_amounts_check" CHECK (
  "subtotal" >= 0 AND "tax_amount" >= 0 AND "total" >= 0 AND "tax_percent" BETWEEN 0 AND 100
  AND ("base_total" IS NULL OR "base_total" >= 0) AND ("exchange_rate" IS NULL OR "exchange_rate" > 0)
  AND "currency" ~ '^[A-Z]{3}$' AND btrim("subject") <> ''
);
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_status_check" CHECK (
  ("status" = 'DRAFT' OR "ordered_at" IS NOT NULL OR "status" = 'CANCELLED')
  AND ("status" <> 'RECEIVED' OR "received_at" IS NOT NULL)
  AND ("status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL)
);
-- 明细：数量为正、已收不超过采购数量、单价与小计非负 / lines: positive quantity, received within ordered, non-negative cost
ALTER TABLE "purchase_order_line_items" ADD CONSTRAINT "purchase_order_line_items_check" CHECK (
  "quantity" > 0 AND "received_quantity" >= 0 AND "received_quantity" <= "quantity" AND "unit_cost" >= 0 AND "line_total" >= 0
);
-- 计数器：序号为正 / counters: positive sequence
ALTER TABLE "document_counters" ADD CONSTRAINT "document_counters_check" CHECK ("last" > 0 AND "year" BETWEEN 2000 AND 9999 AND btrim("kind") <> '');
