-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "base_total" DECIMAL(18,2),
ADD COLUMN     "exchange_rate" DECIMAL(18,8);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "effective_date" DATE NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exchange_rates_organization_id_currency_effective_date_idx" ON "exchange_rates"("organization_id", "currency", "effective_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_organization_id_currency_effective_date_key" ON "exchange_rates"("organization_id", "currency", "effective_date");

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_organization_id_created_by_id_fkey" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- 汇率为正；本币（CNY）不录汇率；币种为三位大写字母 / positive rates; none for the base currency; ISO-style codes
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_rate_check" CHECK ("rate" > 0);
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$' AND "currency" <> 'CNY');

-- 发票汇率快照与折合金额同时有或同时为空 / the invoice rate snapshot and base total come together
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_base_snapshot_check" CHECK (("exchange_rate" IS NULL) = ("base_total" IS NULL) AND ("exchange_rate" IS NULL OR "exchange_rate" > 0));
