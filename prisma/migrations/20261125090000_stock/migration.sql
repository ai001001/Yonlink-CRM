-- CreateEnum
CREATE TYPE "stock_reason" AS ENUM ('ADJUSTMENT', 'PURCHASE_RECEIPT', 'SALES_SHIPMENT', 'SALES_RETURN');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "reorder_level" DECIMAL(18,2),
ADD COLUMN     "stock_quantity" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "reason" "stock_reason" NOT NULL,
    "quantity" DECIMAL(18,2) NOT NULL,
    "balance_after" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "purchase_order_id" UUID,
    "sales_order_id" UUID,
    "note" VARCHAR(200),
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_movements_organization_id_product_id_created_at_idx" ON "stock_movements"("organization_id", "product_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_movements_organization_id_sales_order_id_idx" ON "stock_movements"("organization_id", "sales_order_id");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_organization_id_actor_id_fkey" FOREIGN KEY ("organization_id", "actor_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;



-- 手工约束与触发器 / Hand-written constraints and triggers
-- 流水数量非 0；备注非空白；再订货水平非负 / non-zero movements; non-blank notes; non-negative reorder level
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_check" CHECK ("quantity" <> 0 AND ("note" IS NULL OR btrim("note") <> ''));
ALTER TABLE "products" ADD CONSTRAINT "products_reorder_level_check" CHECK ("reorder_level" IS NULL OR "reorder_level" >= 0);

-- 写入流水时：来源单据须同组织；原子更新产品库存并记录变动后余额（产品行锁使并发流水依次累加）
-- on insert: source orders must be in the same organization; atomically update the product stock and record the
-- balance after (the product row lock serializes concurrent movements)
CREATE FUNCTION "stock_movements_apply"() RETURNS trigger AS $$
DECLARE
  balance numeric;
BEGIN
  IF NEW."purchase_order_id" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "purchase_orders" WHERE "id" = NEW."purchase_order_id" AND "organization_id" = NEW."organization_id") THEN
    RAISE EXCEPTION 'purchase order belongs to another organization' USING ERRCODE = '23503';
  END IF;
  IF NEW."sales_order_id" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "sales_orders" WHERE "id" = NEW."sales_order_id" AND "organization_id" = NEW."organization_id") THEN
    RAISE EXCEPTION 'sales order belongs to another organization' USING ERRCODE = '23503';
  END IF;
  UPDATE "products" SET "stock_quantity" = "stock_quantity" + NEW."quantity", "updated_at" = now()
    WHERE "id" = NEW."product_id" AND "organization_id" = NEW."organization_id"
    RETURNING "stock_quantity" INTO balance;
  IF balance IS NULL THEN
    RAISE EXCEPTION 'product not found' USING ERRCODE = '23503';
  END IF;
  NEW."balance_after" := balance;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_movements_apply"
  BEFORE INSERT ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION "stock_movements_apply"();

-- 流水只增不改；关联单据删除时置空除外 / append-only, except clearing a deleted order reference
CREATE FUNCTION "stock_movements_no_update"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" = OLD."id" AND NEW."organization_id" = OLD."organization_id" AND NEW."product_id" = OLD."product_id"
     AND NEW."reason" = OLD."reason" AND NEW."quantity" = OLD."quantity" AND NEW."balance_after" = OLD."balance_after"
     AND NEW."note" IS NOT DISTINCT FROM OLD."note" AND NEW."actor_id" IS NOT DISTINCT FROM OLD."actor_id" AND NEW."created_at" = OLD."created_at"
     AND (NEW."purchase_order_id" IS NULL OR NEW."purchase_order_id" = OLD."purchase_order_id")
     AND (NEW."sales_order_id" IS NULL OR NEW."sales_order_id" = OLD."sales_order_id") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'stock movements are append-only' USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_movements_no_update"
  BEFORE UPDATE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION "stock_movements_no_update"();

-- 产品库存只能由流水改变：直接修改库存数量被拒绝（流水触发器内的更新通过 pg_trigger_depth 识别）
-- product stock changes only through movements: direct edits are rejected (the movement trigger's update is
-- recognised by pg_trigger_depth)
CREATE FUNCTION "products_stock_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."stock_quantity" IS DISTINCT FROM OLD."stock_quantity" AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'stock quantity changes only through stock movements' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "products_stock_guard"
  BEFORE UPDATE OF "stock_quantity" ON "products"
  FOR EACH ROW EXECUTE FUNCTION "products_stock_guard"();
