-- 多仓库：仓库、各仓库库存、流水所在仓库；为已有产品的组织建默认仓库并回填历史流水
-- Multi-warehouse: warehouses, stock per warehouse, the movement's warehouse; a default warehouse for organizations
-- with products and a backfill of existing movements

-- CreateTable
CREATE TABLE "warehouses" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "address" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_stocks" (
    "organization_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "quantity" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_stocks_pkey" PRIMARY KEY ("product_id","warehouse_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_organization_id_id_key" ON "warehouses"("organization_id", "id");
CREATE UNIQUE INDEX "warehouses_organization_id_code_key" ON "warehouses"("organization_id", "code");
CREATE INDEX "product_stocks_organization_id_warehouse_id_idx" ON "product_stocks"("organization_id", "warehouse_id");

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_stocks" ADD CONSTRAINT "product_stocks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_stocks" ADD CONSTRAINT "product_stocks_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_stocks" ADD CONSTRAINT "product_stocks_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 流水新增列（先可空，回填后再设为必填）/ new movement columns (nullable first, required after the backfill)
ALTER TABLE "stock_movements" ADD COLUMN "transfer_id" UUID,
ADD COLUMN "warehouse_balance_after" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN "warehouse_id" UUID;

-- 回填：有产品的组织各建一个默认仓库（代码 MAIN），历史流水与现有库存归入默认仓库
-- backfill: a default warehouse (code MAIN) for every organization with products; existing movements and stock go there
INSERT INTO "warehouses" ("id", "organization_id", "code", "name", "is_active", "is_default", "created_at", "updated_at")
SELECT gen_random_uuid(), o."id", 'MAIN', '默认仓库', true, true, now(), now()
FROM "organizations" o WHERE EXISTS (SELECT 1 FROM "products" p WHERE p."organization_id" = o."id");

-- 流水只增不改：回填期间在本事务内暂停该保护 / movements are append-only: the guard is paused for the backfill inside this transaction
ALTER TABLE "stock_movements" DISABLE TRIGGER "stock_movements_no_update";
UPDATE "stock_movements" m SET "warehouse_id" = w."id", "warehouse_balance_after" = m."balance_after"
FROM "warehouses" w WHERE w."organization_id" = m."organization_id" AND w."is_default";
ALTER TABLE "stock_movements" ENABLE TRIGGER "stock_movements_no_update";

INSERT INTO "product_stocks" ("organization_id", "product_id", "warehouse_id", "quantity", "updated_at")
SELECT p."organization_id", p."id", w."id", p."stock_quantity", now()
FROM "products" p JOIN "warehouses" w ON w."organization_id" = p."organization_id" AND w."is_default";

ALTER TABLE "stock_movements" ALTER COLUMN "warehouse_id" SET NOT NULL;
CREATE INDEX "stock_movements_organization_id_warehouse_id_created_at_idx" ON "stock_movements"("organization_id", "warehouse_id", "created_at");
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;



-- 手工约束与触发器 / Hand-written constraints and triggers
-- 仓库：代码为大写字母、数字、- 与 _；名称非空白；默认仓库必须启用；每组织一个默认仓库
-- warehouses: upper-case code; non-blank name; the default must be active; one default per organization
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_check" CHECK (
  "code" ~ '^[A-Z0-9_-]{1,20}$' AND btrim("name") <> '' AND ("address" IS NULL OR btrim("address") <> '') AND NOT ("is_default" AND NOT "is_active")
);
CREATE UNIQUE INDEX "warehouses_one_default" ON "warehouses"("organization_id") WHERE "is_default";
-- 调拨流水必有调拨 ID，其他流水没有 / transfer movements have a transfer id, others do not
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_transfer_check" CHECK (("reason" = 'TRANSFER') = ("transfer_id" IS NOT NULL));

-- 写入流水时：来源单据须同组织；原子更新产品总库存与该仓库库存，记录两个余额
-- on insert: source orders in the same organization; atomically update the product total and the warehouse stock and
-- record both balances
CREATE OR REPLACE FUNCTION "stock_movements_apply"() RETURNS trigger AS $$
DECLARE
  balance numeric;
  wbalance numeric;
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
  INSERT INTO "product_stocks" ("organization_id", "product_id", "warehouse_id", "quantity", "updated_at")
    VALUES (NEW."organization_id", NEW."product_id", NEW."warehouse_id", NEW."quantity", now())
    ON CONFLICT ("product_id", "warehouse_id") DO UPDATE SET "quantity" = "product_stocks"."quantity" + EXCLUDED."quantity", "updated_at" = now()
    RETURNING "quantity" INTO wbalance;
  NEW."balance_after" := balance;
  NEW."warehouse_balance_after" := wbalance;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 流水只增不改（新增列一并保护）；关联单据删除时置空除外 / append-only including the new columns, except clearing a deleted order reference
CREATE OR REPLACE FUNCTION "stock_movements_no_update"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" = OLD."id" AND NEW."organization_id" = OLD."organization_id" AND NEW."product_id" = OLD."product_id"
     AND NEW."reason" = OLD."reason" AND NEW."quantity" = OLD."quantity" AND NEW."balance_after" = OLD."balance_after"
     AND NEW."warehouse_id" = OLD."warehouse_id" AND NEW."warehouse_balance_after" = OLD."warehouse_balance_after"
     AND NEW."transfer_id" IS NOT DISTINCT FROM OLD."transfer_id"
     AND NEW."note" IS NOT DISTINCT FROM OLD."note" AND NEW."actor_id" IS NOT DISTINCT FROM OLD."actor_id" AND NEW."created_at" = OLD."created_at"
     AND (NEW."purchase_order_id" IS NULL OR NEW."purchase_order_id" = OLD."purchase_order_id")
     AND (NEW."sales_order_id" IS NULL OR NEW."sales_order_id" = OLD."sales_order_id") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'stock movements are append-only' USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

-- 各仓库库存只能由流水改变（流水触发器内的写入通过 pg_trigger_depth 识别）
-- per-warehouse stock changes only through movements (writes from the movement trigger are recognised by pg_trigger_depth)
CREATE FUNCTION "product_stocks_guard"() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() < 2 AND (TG_OP = 'INSERT' OR NEW."quantity" IS DISTINCT FROM OLD."quantity") THEN
    RAISE EXCEPTION 'warehouse stock changes only through stock movements' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "product_stocks_guard"
  BEFORE INSERT OR UPDATE ON "product_stocks"
  FOR EACH ROW EXECUTE FUNCTION "product_stocks_guard"();
