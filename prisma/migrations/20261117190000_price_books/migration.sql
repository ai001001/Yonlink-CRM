-- CreateEnum
CREATE TYPE "price_book_pricing_model" AS ENUM ('FLAT', 'DIFFERENTIAL');

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "price_book_id" UUID;

-- AlterTable
ALTER TABLE "deal_line_items" ADD COLUMN     "price_book_name" VARCHAR(200);

-- CreateTable
CREATE TABLE "price_books" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'CNY',
    "pricing_model" "price_book_pricing_model" NOT NULL DEFAULT 'FLAT',
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "price_books_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_book_entries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "price_book_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "list_price" DECIMAL(18,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "price_book_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_book_tiers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "price_book_id" UUID NOT NULL,
    "from_quantity" DECIMAL(18,2) NOT NULL,
    "to_quantity" DECIMAL(18,2),
    "discount_percent" DECIMAL(5,2) NOT NULL,

    CONSTRAINT "price_book_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_books_organization_id_is_active_idx" ON "price_books"("organization_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "price_books_organization_id_id_key" ON "price_books"("organization_id", "id");

-- CreateIndex
CREATE INDEX "price_book_entries_organization_id_product_id_idx" ON "price_book_entries"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_book_entries_price_book_id_product_id_key" ON "price_book_entries"("price_book_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_book_tiers_price_book_id_from_quantity_key" ON "price_book_tiers"("price_book_id", "from_quantity");

-- CreateIndex
CREATE INDEX "accounts_organization_id_price_book_id_idx" ON "accounts"("organization_id", "price_book_id");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_organization_id_price_book_id_fkey" FOREIGN KEY ("organization_id", "price_book_id") REFERENCES "price_books"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "price_books" ADD CONSTRAINT "price_books_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_book_entries" ADD CONSTRAINT "price_book_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_book_entries" ADD CONSTRAINT "price_book_entries_organization_id_price_book_id_fkey" FOREIGN KEY ("organization_id", "price_book_id") REFERENCES "price_books"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_book_entries" ADD CONSTRAINT "price_book_entries_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_book_tiers" ADD CONSTRAINT "price_book_tiers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_book_tiers" ADD CONSTRAINT "price_book_tiers_organization_id_price_book_id_fkey" FOREIGN KEY ("organization_id", "price_book_id") REFERENCES "price_books"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;



-- 手工约束 / Hand-written constraints
-- 价格表：名称组织内唯一（不区分大小写）、非空白；币种代码 / price books: unique case-insensitive non-blank names; currency code
CREATE UNIQUE INDEX "price_books_name_key" ON "price_books"("organization_id", lower("name"));
ALTER TABLE "price_books" ADD CONSTRAINT "price_books_check" CHECK (btrim("name") <> '' AND "currency" ~ '^[A-Z]{3}$');
-- 产品价格非负 / non-negative list prices
ALTER TABLE "price_book_entries" ADD CONSTRAINT "price_book_entries_check" CHECK ("list_price" >= 0);
-- 阶梯：起始为正、截止不小于起始、折扣 0–100 / tiers: positive start, end not below start, discount 0–100
ALTER TABLE "price_book_tiers" ADD CONSTRAINT "price_book_tiers_check" CHECK (
  "from_quantity" > 0 AND ("to_quantity" IS NULL OR "to_quantity" >= "from_quantity") AND "discount_percent" BETWEEN 0 AND 100
);
