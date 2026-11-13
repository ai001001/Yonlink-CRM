-- CreateTable
CREATE TABLE "sales_targets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "month" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sales_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_targets_organization_id_month_idx" ON "sales_targets"("organization_id", "month");

-- CreateIndex
CREATE UNIQUE INDEX "sales_targets_organization_id_user_id_month_currency_key" ON "sales_targets"("organization_id", "user_id", "month", "currency");

-- AddForeignKey
ALTER TABLE "sales_targets" ADD CONSTRAINT "sales_targets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_targets" ADD CONSTRAINT "sales_targets_organization_id_user_id_fkey" FOREIGN KEY ("organization_id", "user_id") REFERENCES "users"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_targets" ADD CONSTRAINT "sales_targets_organization_id_updated_by_id_fkey" FOREIGN KEY ("organization_id", "updated_by_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- 业务约束：金额非负；月份必须是当月 1 日；币种为 3 位大写字母
-- Business constraints: non-negative amount; month is the first day of a month; 3-letter upper-case currency
ALTER TABLE "sales_targets" ADD CONSTRAINT "sales_targets_amount_non_negative" CHECK ("amount" >= 0);
ALTER TABLE "sales_targets" ADD CONSTRAINT "sales_targets_month_first_day" CHECK (EXTRACT(DAY FROM "month") = 1);
ALTER TABLE "sales_targets" ADD CONSTRAINT "sales_targets_currency_code" CHECK ("currency" ~ '^[A-Z]{3}$');
