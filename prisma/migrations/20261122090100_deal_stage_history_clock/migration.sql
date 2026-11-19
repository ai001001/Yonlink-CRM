-- 修正：变化时间改用 clock_timestamp()。now() 是事务开始时间，并发修改同一商机时，先开始、后提交的事务会得到更早的时间，
-- 使历史顺序与实际顺序不符；触发器在取得行锁之后执行，clock_timestamp() 保证同一商机的变化时间按实际顺序递增。
-- Fix: use clock_timestamp() for change times. now() is the transaction start, so with concurrent edits of one deal a
-- transaction that started earlier but committed later got an earlier time, putting the history out of order. The
-- trigger runs after the row lock is taken, so clock_timestamp() keeps one deal's change times in actual order.
CREATE OR REPLACE FUNCTION "deals_stage_history"() RETURNS trigger AS $$
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
          CASE WHEN TG_OP = 'INSERT' THEN NEW."created_at" ELSE clock_timestamp() END);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
