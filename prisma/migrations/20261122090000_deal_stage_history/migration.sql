-- CreateTable
CREATE TABLE "deal_stage_history" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "stage" "deal_stage" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "expected_close_date" DATE,
    "changed_by_id" UUID,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_stage_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deal_stage_history_organization_id_deal_id_changed_at_idx" ON "deal_stage_history"("organization_id", "deal_id", "changed_at");

-- AddForeignKey
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_organization_id_deal_id_fkey" FOREIGN KEY ("organization_id", "deal_id") REFERENCES "deals"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_organization_id_changed_by_id_fkey" FOREIGN KEY ("organization_id", "changed_by_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;



-- 手工约束与触发器 / Hand-written constraints and triggers
-- 金额非负、币种为三位大写字母 / non-negative amount, three-letter upper-case currency
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_check" CHECK ("amount" >= 0 AND "currency" ~ '^[A-Z]{3}$');

-- 新建商机及阶段、金额、币种、预计成交日变化时记录一行。
-- 修改人取事务内的 yonlink.actor_id，且必须是本组织用户（否则记为空，不影响商机写入）；
-- 新建时的时间取商机创建时间（导入、恢复、演示数据可能指定创建时间）。
-- Record a row on create and whenever stage, amount, currency or expected close date changes. The actor comes from
-- the transaction's yonlink.actor_id and must be a member of the organization (otherwise null, never failing the write);
-- on insert the time is the deal's created_at (imports, restores and demo data may set it).
CREATE FUNCTION "deals_stage_history"() RETURNS trigger AS $$
DECLARE
  actor uuid;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."stage" IS NOT DISTINCT FROM OLD."stage"
     AND NEW."amount" IS NOT DISTINCT FROM OLD."amount"
     AND NEW."currency" IS NOT DISTINCT FROM OLD."currency"
     AND NEW."expected_close_date" IS NOT DISTINCT FROM OLD."expected_close_date" THEN
    RETURN NEW;
  END IF;
  BEGIN
    actor := nullif(current_setting('yonlink.actor_id', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    actor := NULL;
  END;
  IF actor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = actor AND "organization_id" = NEW."organization_id") THEN
    actor := NULL;
  END IF;
  INSERT INTO "deal_stage_history" ("id", "organization_id", "deal_id", "stage", "amount", "currency", "expected_close_date", "changed_by_id", "changed_at")
  VALUES (gen_random_uuid(), NEW."organization_id", NEW."id", NEW."stage", NEW."amount", NEW."currency", NEW."expected_close_date", actor,
          CASE WHEN TG_OP = 'INSERT' THEN NEW."created_at" ELSE now() END);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "deals_stage_history"
  AFTER INSERT OR UPDATE OF "stage", "amount", "currency", "expected_close_date" ON "deals"
  FOR EACH ROW EXECUTE FUNCTION "deals_stage_history"();

-- 历史只增不改 / history is append-only
CREATE FUNCTION "deal_stage_history_no_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'deal stage history is append-only' USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "deal_stage_history_no_update"
  BEFORE UPDATE ON "deal_stage_history"
  FOR EACH ROW EXECUTE FUNCTION "deal_stage_history_no_update"();

-- 已有商机：以当前状态补一行（创建时间、修改人为空；此前的变化无从得知）
-- existing deals: one row with the current values at created_at (no actor; earlier changes are unknown)
INSERT INTO "deal_stage_history" ("id", "organization_id", "deal_id", "stage", "amount", "currency", "expected_close_date", "changed_by_id", "changed_at")
SELECT gen_random_uuid(), "organization_id", "id", "stage", "amount", "currency", "expected_close_date", NULL, "created_at" FROM "deals";
