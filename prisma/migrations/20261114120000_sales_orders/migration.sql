-- CreateEnum
CREATE TYPE "sales_order_status" AS ENUM ('CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED');

-- CreateTable
CREATE TABLE "sales_orders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "order_number" VARCHAR(30) NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "status" "sales_order_status" NOT NULL DEFAULT 'CONFIRMED',
    "currency" CHAR(3) NOT NULL,
    "tax_percent" DECIMAL(5,2) NOT NULL,
    "subtotal" DECIMAL(18,2) NOT NULL,
    "tax_amount" DECIMAL(18,2) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "expected_delivery" DATE,
    "shipping_address" VARCHAR(500),
    "notes" TEXT,
    "cancel_reason" VARCHAR(500),
    "created_by_id" UUID,
    "shipped_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_line_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "product_sku" VARCHAR(50) NOT NULL,
    "product_name" VARCHAR(200) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "quantity" DECIMAL(18,2) NOT NULL,
    "unit_price" DECIMAL(18,2) NOT NULL,
    "discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "sales_order_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_orders_organization_id_deal_id_idx" ON "sales_orders"("organization_id", "deal_id");

-- CreateIndex
CREATE INDEX "sales_orders_organization_id_quote_id_idx" ON "sales_orders"("organization_id", "quote_id");

-- CreateIndex
CREATE INDEX "sales_orders_organization_id_created_at_idx" ON "sales_orders"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "sales_orders_organization_id_status_idx" ON "sales_orders"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_organization_id_id_key" ON "sales_orders"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_organization_id_order_number_key" ON "sales_orders"("organization_id", "order_number");

-- CreateIndex
CREATE INDEX "sales_order_line_items_organization_id_sales_order_id_idx" ON "sales_order_line_items"("organization_id", "sales_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_line_items_sales_order_id_position_key" ON "sales_order_line_items"("sales_order_id", "position");

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_organization_id_quote_id_fkey" FOREIGN KEY ("organization_id", "quote_id") REFERENCES "quotes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_organization_id_deal_id_fkey" FOREIGN KEY ("organization_id", "deal_id") REFERENCES "deals"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_organization_id_created_by_id_fkey" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sales_order_line_items" ADD CONSTRAINT "sales_order_line_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_line_items" ADD CONSTRAINT "sales_order_line_items_organization_id_sales_order_id_fkey" FOREIGN KEY ("organization_id", "sales_order_id") REFERENCES "sales_orders"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 同一报价单同时只能有一张未取消的订单 / one non-cancelled order per quote
CREATE UNIQUE INDEX "sales_orders_active_quote_key" ON "sales_orders"("organization_id", "quote_id") WHERE "status" <> 'CANCELLED';

-- 金额与状态时间一致性 / amount and status timestamp consistency
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_total_check" CHECK ("total" = "subtotal" + "tax_amount" AND "subtotal" >= 0 AND "tax_amount" >= 0);
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_tax_percent_check" CHECK ("tax_percent" >= 0 AND "tax_percent" <= 100);
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_shipped_check" CHECK ("status" NOT IN ('SHIPPED', 'DELIVERED') OR "shipped_at" IS NOT NULL);
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_delivered_check" CHECK (("status" = 'DELIVERED') = ("delivered_at" IS NOT NULL));
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_cancelled_check" CHECK (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL));
ALTER TABLE "sales_order_line_items" ADD CONSTRAINT "sales_order_line_items_amount_check" CHECK ("quantity" > 0 AND "unit_price" >= 0 AND "discount_percent" >= 0 AND "discount_percent" <= 100 AND "line_total" >= 0);
