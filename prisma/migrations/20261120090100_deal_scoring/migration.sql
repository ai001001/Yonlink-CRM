-- 商机评分：分数列、规则约束（加入商机与金额阈值规则）、评分函数与触发器。
-- Deal scoring: score column, rule constraint (now with deals and the amount threshold kind), scoring functions and
-- triggers.

-- AlterTable
ALTER TABLE "deals" ADD COLUMN "score" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "deals_organization_id_score_idx" ON "deals"("organization_id", "score" DESC);

-- 规则约束重建：增加商机对象与“金额达到阈值”类型（阈值为不超过 16 位的非负整数，仅商机可用）
-- rebuild the rule check: add the deal entity and the amount threshold kind (a non-negative integer of up to 16 digits,
-- deals only)
ALTER TABLE "scoring_rules" DROP CONSTRAINT "scoring_rules_check";
ALTER TABLE "scoring_rules" ADD CONSTRAINT "scoring_rules_check" CHECK (
  "points" BETWEEN -100 AND 100 AND "points" <> 0 AND "position" >= 0
  AND (
    ("kind" IN ('ACTIVITY_COUNT', 'RELATED_COUNT') AND "value" IS NULL AND "max_count" BETWEEN 1 AND 50)
    OR ("kind" IN ('FIELD_EQUALS', 'FIELD_FILLED') AND "max_count" IS NULL)
    OR ("kind" = 'AMOUNT_AT_LEAST' AND "field" = 'amount' AND "max_count" IS NULL AND "value" ~ '^[0-9]{1,16}$')
  )
  AND CASE "entity"
    WHEN 'LEAD' THEN
      ("kind" = 'FIELD_EQUALS' AND (
        ("field" = 'source' AND "value" IN ('WEBSITE', 'REFERRAL', 'EXHIBITION', 'COLD_CALL', 'ADVERTISEMENT', 'SOCIAL_MEDIA', 'OTHER'))
        OR ("field" = 'status' AND "value" IN ('NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED'))))
      OR ("kind" = 'FIELD_FILLED' AND "value" IS NULL AND "field" IN ('company', 'title', 'email', 'phone', 'mobile', 'description', 'campaign', 'web_form'))
      OR ("kind" = 'ACTIVITY_COUNT' AND "field" IS NULL)
    WHEN 'ACCOUNT' THEN
      ("kind" = 'FIELD_EQUALS' AND "field" = 'industry'
        AND "value" IN ('MANUFACTURING', 'IT', 'FINANCE', 'RETAIL', 'EDUCATION', 'HEALTHCARE', 'CONSTRUCTION', 'LOGISTICS', 'GOVERNMENT', 'OTHER'))
      OR ("kind" = 'FIELD_FILLED' AND "value" IS NULL AND "field" IN ('phone', 'website', 'address', 'description', 'price_book'))
      OR ("kind" = 'ACTIVITY_COUNT' AND "field" IS NULL)
      OR ("kind" = 'RELATED_COUNT' AND "field" IN ('contacts', 'won_deals', 'open_deals'))
    WHEN 'CONTACT' THEN
      ("kind" = 'FIELD_EQUALS' AND "field" = 'is_primary' AND "value" = 'true')
      OR ("kind" = 'FIELD_FILLED' AND "value" IS NULL AND "field" IN ('title', 'phone', 'email'))
      OR ("kind" = 'RELATED_COUNT' AND "field" IN ('deal_roles', 'decision_roles'))
    WHEN 'DEAL' THEN
      ("kind" = 'FIELD_EQUALS' AND "field" = 'stage'
        AND "value" IN ('QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST'))
      OR ("kind" = 'FIELD_FILLED' AND "value" IS NULL AND "field" IN ('expected_close_date', 'description', 'campaign'))
      OR ("kind" = 'ACTIVITY_COUNT' AND "field" IS NULL)
      OR ("kind" = 'RELATED_COUNT' AND "field" IN ('contact_roles', 'decision_roles', 'line_items', 'quotes', 'competitors'))
      OR "kind" = 'AMOUNT_AT_LEAST'
    ELSE false
  END
);

-- 商机金额折合人民币：人民币为原值；外币取当天及以前最近一期汇率；没有汇率时为空（金额阈值规则不命中）
-- a deal's amount in CNY: CNY as is; foreign currencies use the latest rate effective today or earlier; null when there
-- is no rate (amount threshold rules then do not match)
CREATE FUNCTION "deal_base_amount"(d "deals") RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN d.currency = 'CNY' THEN d.amount ELSE d.amount * (
    SELECT r.rate FROM "exchange_rates" r
    WHERE r.organization_id = d.organization_id AND r.currency = d.currency AND r.effective_date <= current_date
    ORDER BY r.effective_date DESC LIMIT 1
  ) END
$$;

-- 商机命中的规则与得分：阶段、资料完整度、金额阈值、已完成跟进、联系人角色、决策人、产品明细、报价单、竞争对手
-- the rules a deal matches: stage, completeness, amount thresholds, completed activities, contact and decision-maker
-- roles, line items, quotes and competitors
CREATE FUNCTION "deal_score_items"(d "deals") RETURNS TABLE ("rule_id" uuid, "points" integer) LANGUAGE sql STABLE AS $$
  SELECT x.id, x.points FROM (
    SELECT r.id, r.position,
      CASE r.kind
        WHEN 'ACTIVITY_COUNT' THEN r.points * LEAST(r.max_count, (
          SELECT count(*) FROM "activities" t WHERE t.organization_id = d.organization_id AND t.deal_id = d.id AND t.completed
        ))::integer
        WHEN 'RELATED_COUNT' THEN r.points * LEAST(r.max_count, CASE r.field
          WHEN 'contact_roles' THEN (SELECT count(*) FROM "deal_contact_roles" x WHERE x.organization_id = d.organization_id AND x.deal_id = d.id)
          WHEN 'decision_roles' THEN (SELECT count(*) FROM "deal_contact_roles" x WHERE x.organization_id = d.organization_id AND x.deal_id = d.id AND x.role = 'DECISION_MAKER')
          WHEN 'line_items' THEN (SELECT count(*) FROM "deal_line_items" x WHERE x.organization_id = d.organization_id AND x.deal_id = d.id)
          WHEN 'quotes' THEN (SELECT count(*) FROM "quotes" x WHERE x.organization_id = d.organization_id AND x.deal_id = d.id)
          WHEN 'competitors' THEN (SELECT count(*) FROM "deal_competitors" x WHERE x.organization_id = d.organization_id AND x.deal_id = d.id)
          ELSE 0 END)::integer
        ELSE r.points END AS points
    FROM "scoring_rules" r
    WHERE r.organization_id = d.organization_id AND r.entity = 'DEAL' AND r.is_active AND (
      r.kind IN ('ACTIVITY_COUNT', 'RELATED_COUNT')
      OR (r.kind = 'FIELD_EQUALS' AND r.value = CASE r.field WHEN 'stage' THEN d.stage::text END)
      OR (r.kind = 'FIELD_FILLED' AND CASE r.field
        WHEN 'expected_close_date' THEN d.expected_close_date IS NOT NULL
        WHEN 'description' THEN coalesce(btrim(d.description), '') <> ''
        WHEN 'campaign' THEN d.campaign_id IS NOT NULL
        ELSE false END)
      OR (r.kind = 'AMOUNT_AT_LEAST' AND coalesce("deal_base_amount"(d) >= r.value::numeric, false))
    )
  ) x
  WHERE x.points <> 0
  ORDER BY x.position, x.id
$$;

-- 商机写入时计算分数（客户端写入的分数会被覆盖）/ compute the score on every deal write
CREATE FUNCTION "deals_score"() RETURNS trigger AS $$
BEGIN
  NEW."score" := coalesce((SELECT sum(i.points) FROM "deal_score_items"(NEW) i), 0);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "deals_score"
  BEFORE INSERT OR UPDATE ON "deals"
  FOR EACH ROW EXECUTE FUNCTION "deals_score"();

-- 跟进变化时重算相关线索、客户与商机（取代上一版只处理线索与客户的触发器）
-- activity changes rescore the linked leads, accounts and deals (replaces the lead-and-account version)
DROP TRIGGER "activities_rescore" ON "activities";

CREATE OR REPLACE FUNCTION "activities_rescore"() RETURNS trigger AS $$
BEGIN
  -- 原关联（更新时含完成状态变化）/ the previous links (on update this also covers completion changes)
  IF TG_OP <> 'INSERT' THEN
    IF OLD."lead_id" IS NOT NULL THEN UPDATE "leads" SET "score" = "score" WHERE "id" = OLD."lead_id"; END IF;
    IF OLD."account_id" IS NOT NULL THEN UPDATE "accounts" SET "score" = "score" WHERE "id" = OLD."account_id"; END IF;
    IF OLD."deal_id" IS NOT NULL THEN UPDATE "deals" SET "score" = "score" WHERE "id" = OLD."deal_id"; END IF;
  END IF;
  -- 新关联 / the new links
  IF TG_OP <> 'DELETE' THEN
    IF NEW."lead_id" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."lead_id" IS DISTINCT FROM OLD."lead_id") THEN
      UPDATE "leads" SET "score" = "score" WHERE "id" = NEW."lead_id";
    END IF;
    IF NEW."account_id" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."account_id" IS DISTINCT FROM OLD."account_id") THEN
      UPDATE "accounts" SET "score" = "score" WHERE "id" = NEW."account_id";
    END IF;
    IF NEW."deal_id" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."deal_id" IS DISTINCT FROM OLD."deal_id") THEN
      UPDATE "deals" SET "score" = "score" WHERE "id" = NEW."deal_id";
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "activities_rescore"
  AFTER INSERT OR DELETE OR UPDATE OF "lead_id", "account_id", "deal_id", "completed" ON "activities"
  FOR EACH ROW EXECUTE FUNCTION "activities_rescore"();

-- 关联记录（联系人角色、产品明细、报价单、竞争对手）增删或换商机时重算商机；联系人角色改角色时也重算
-- related records (contact roles, line items, quotes, competitors) rescore their deals when added, removed or moved;
-- changing a contact's role rescores the deal too
CREATE FUNCTION "related_rescore_deal"() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN UPDATE "deals" SET "score" = "score" WHERE "id" = OLD."deal_id"; END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW."deal_id" IS DISTINCT FROM OLD."deal_id") THEN
    UPDATE "deals" SET "score" = "score" WHERE "id" = NEW."deal_id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "deal_roles_rescore_deal"
  AFTER INSERT OR DELETE OR UPDATE OF "role", "deal_id" ON "deal_contact_roles"
  FOR EACH ROW EXECUTE FUNCTION "related_rescore_deal"();
CREATE TRIGGER "deal_line_items_rescore_deal"
  AFTER INSERT OR DELETE OR UPDATE OF "deal_id" ON "deal_line_items"
  FOR EACH ROW EXECUTE FUNCTION "related_rescore_deal"();
CREATE TRIGGER "quotes_rescore_deal"
  AFTER INSERT OR DELETE OR UPDATE OF "deal_id" ON "quotes"
  FOR EACH ROW EXECUTE FUNCTION "related_rescore_deal"();
CREATE TRIGGER "deal_competitors_rescore_deal"
  AFTER INSERT OR DELETE OR UPDATE OF "deal_id" ON "deal_competitors"
  FOR EACH ROW EXECUTE FUNCTION "related_rescore_deal"();

-- 汇率新增、修改、删除时重算该币种的商机（金额阈值规则按折合人民币判断）
-- exchange rate changes rescore that currency's deals (amount thresholds compare the CNY amount)
CREATE FUNCTION "exchange_rates_rescore_deals"() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE "deals" SET "score" = "score" WHERE "organization_id" = OLD."organization_id" AND "currency" = OLD."currency";
  END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW."currency" IS DISTINCT FROM OLD."currency" OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id") THEN
    UPDATE "deals" SET "score" = "score" WHERE "organization_id" = NEW."organization_id" AND "currency" = NEW."currency";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "exchange_rates_rescore_deals"
  AFTER INSERT OR DELETE OR UPDATE ON "exchange_rates"
  FOR EACH ROW EXECUTE FUNCTION "exchange_rates_rescore_deals"();
