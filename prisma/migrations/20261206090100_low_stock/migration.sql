-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "product_id" UUID;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "low_stock_alerted_at" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "notifications_organization_id_product_id_idx" ON "notifications"("organization_id", "product_id");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;




-- 手工约束：通知恰好指向一个对象（新增产品）/ hand-written: a notification targets exactly one record (products added)
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_one_target_check";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_one_target_check" CHECK (num_nonnulls("lead_id", "account_id", "deal_id", "activity_id", "ticket_id", "product_id") = 1);
