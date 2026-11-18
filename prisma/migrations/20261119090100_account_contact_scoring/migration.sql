-- 客户与联系人评分：分数列、按对象的规则约束、评分函数与触发器（分数在任何写入途径下都由数据库计算）。
-- Account and contact scoring: score columns, per-entity rule constraints, scoring functions and triggers (scores are
-- always computed by the database, whatever the write path).

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN "score" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "contacts" ADD COLUMN "score" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "accounts_organization_id_score_idx" ON "accounts"("organization_id", "score" DESC);
CREATE INDEX "contacts_organization_id_score_idx" ON "contacts"("organization_id", "score" DESC);

-- 规则约束：分值 -100–100 且非 0；字段与取值按对象和类型限定在固定集合；计数类规则上限 1–50
-- rule check: points in -100..100 and non-zero; fields and values from fixed sets per entity and kind; count caps 1..50
ALTER TABLE "scoring_rules" ADD CONSTRAINT "scoring_rules_check" CHECK (
  "points" BETWEEN -100 AND 100 AND "points" <> 0 AND "position" >= 0
  AND (
    ("kind" IN ('ACTIVITY_COUNT', 'RELATED_COUNT') AND "value" IS NULL AND "max_count" BETWEEN 1 AND 50)
    OR ("kind" IN ('FIELD_EQUALS', 'FIELD_FILLED') AND "max_count" IS NULL)
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
    ELSE false
  END
);

-- 线索评分函数改用新表并只取线索规则 / the lead function reads the renamed table, lead rules only
CREATE OR REPLACE FUNCTION "lead_score_items"(l "leads") RETURNS TABLE ("rule_id" uuid, "points" integer) LANGUAGE sql STABLE AS $$
  SELECT x.id, x.points FROM (
    SELECT r.id, r.position,
      CASE WHEN r.kind = 'ACTIVITY_COUNT'
        THEN r.points * LEAST(r.max_count, (
          SELECT count(*) FROM "activities" a WHERE a.organization_id = l.organization_id AND a.lead_id = l.id AND a.completed
        ))::integer
        ELSE r.points END AS points
    FROM "scoring_rules" r
    WHERE r.organization_id = l.organization_id AND r.entity = 'LEAD' AND r.is_active AND (
      r.kind = 'ACTIVITY_COUNT'
      OR (r.kind = 'FIELD_EQUALS' AND r.value = CASE r.field WHEN 'source' THEN l.source WHEN 'status' THEN l.status::text END)
      OR (r.kind = 'FIELD_FILLED' AND CASE r.field
        WHEN 'company' THEN coalesce(btrim(l.company), '') <> ''
        WHEN 'title' THEN coalesce(btrim(l.title), '') <> ''
        WHEN 'email' THEN coalesce(btrim(l.email), '') <> ''
        WHEN 'phone' THEN coalesce(btrim(l.phone), '') <> ''
        WHEN 'mobile' THEN coalesce(btrim(l.mobile), '') <> ''
        WHEN 'description' THEN coalesce(btrim(l.description), '') <> ''
        WHEN 'campaign' THEN l.campaign_id IS NOT NULL
        WHEN 'web_form' THEN l.web_form_id IS NOT NULL
        ELSE false END)
    )
  ) x
  WHERE x.points <> 0
  ORDER BY x.position, x.id
$$;

-- 客户命中的规则与得分：行业、资料完整度、已完成跟进、联系人数、赢单与进行中商机数
-- the rules an account matches: industry, completeness, completed activities, contacts, won and open deals
CREATE FUNCTION "account_score_items"(a "accounts") RETURNS TABLE ("rule_id" uuid, "points" integer) LANGUAGE sql STABLE AS $$
  SELECT x.id, x.points FROM (
    SELECT r.id, r.position,
      CASE r.kind
        WHEN 'ACTIVITY_COUNT' THEN r.points * LEAST(r.max_count, (
          SELECT count(*) FROM "activities" t WHERE t.organization_id = a.organization_id AND t.account_id = a.id AND t.completed
        ))::integer
        WHEN 'RELATED_COUNT' THEN r.points * LEAST(r.max_count, CASE r.field
          WHEN 'contacts' THEN (SELECT count(*) FROM "contacts" c WHERE c.organization_id = a.organization_id AND c.account_id = a.id)
          WHEN 'won_deals' THEN (SELECT count(*) FROM "deals" d WHERE d.organization_id = a.organization_id AND d.account_id = a.id AND d.stage = 'CLOSED_WON')
          WHEN 'open_deals' THEN (SELECT count(*) FROM "deals" d WHERE d.organization_id = a.organization_id AND d.account_id = a.id AND d.stage NOT IN ('CLOSED_WON', 'CLOSED_LOST'))
          ELSE 0 END)::integer
        ELSE r.points END AS points
    FROM "scoring_rules" r
    WHERE r.organization_id = a.organization_id AND r.entity = 'ACCOUNT' AND r.is_active AND (
      r.kind IN ('ACTIVITY_COUNT', 'RELATED_COUNT')
      OR (r.kind = 'FIELD_EQUALS' AND r.value = CASE r.field WHEN 'industry' THEN a.industry END)
      OR (r.kind = 'FIELD_FILLED' AND CASE r.field
        WHEN 'phone' THEN coalesce(btrim(a.phone), '') <> ''
        WHEN 'website' THEN coalesce(btrim(a.website), '') <> ''
        WHEN 'address' THEN coalesce(btrim(a.address), '') <> ''
        WHEN 'description' THEN coalesce(btrim(a.description), '') <> ''
        WHEN 'price_book' THEN a.price_book_id IS NOT NULL
        ELSE false END)
    )
  ) x
  WHERE x.points <> 0
  ORDER BY x.position, x.id
$$;

-- 联系人命中的规则与得分：主要联系人、资料完整度、商机中的角色数与决策人角色数
-- the rules a contact matches: primary contact, completeness, deal roles and decision-maker roles
CREATE FUNCTION "contact_score_items"(c "contacts") RETURNS TABLE ("rule_id" uuid, "points" integer) LANGUAGE sql STABLE AS $$
  SELECT x.id, x.points FROM (
    SELECT r.id, r.position,
      CASE WHEN r.kind = 'RELATED_COUNT' THEN r.points * LEAST(r.max_count, CASE r.field
          WHEN 'deal_roles' THEN (SELECT count(*) FROM "deal_contact_roles" dr WHERE dr.organization_id = c.organization_id AND dr.contact_id = c.id)
          WHEN 'decision_roles' THEN (SELECT count(*) FROM "deal_contact_roles" dr WHERE dr.organization_id = c.organization_id AND dr.contact_id = c.id AND dr.role = 'DECISION_MAKER')
          ELSE 0 END)::integer
        ELSE r.points END AS points
    FROM "scoring_rules" r
    WHERE r.organization_id = c.organization_id AND r.entity = 'CONTACT' AND r.is_active AND (
      r.kind = 'RELATED_COUNT'
      OR (r.kind = 'FIELD_EQUALS' AND r.value = CASE r.field WHEN 'is_primary' THEN c.is_primary::text END)
      OR (r.kind = 'FIELD_FILLED' AND CASE r.field
        WHEN 'title' THEN coalesce(btrim(c.title), '') <> ''
        WHEN 'phone' THEN coalesce(btrim(c.phone), '') <> ''
        WHEN 'email' THEN coalesce(btrim(c.email), '') <> ''
        ELSE false END)
    )
  ) x
  WHERE x.points <> 0
  ORDER BY x.position, x.id
$$;

-- 客户、联系人写入时计算分数（客户端写入的分数会被覆盖）/ compute scores on account and contact writes
CREATE FUNCTION "accounts_score"() RETURNS trigger AS $$
BEGIN
  NEW."score" := coalesce((SELECT sum(i.points) FROM "account_score_items"(NEW) i), 0);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "accounts_score"
  BEFORE INSERT OR UPDATE ON "accounts"
  FOR EACH ROW EXECUTE FUNCTION "accounts_score"();

CREATE FUNCTION "contacts_score"() RETURNS trigger AS $$
BEGIN
  NEW."score" := coalesce((SELECT sum(i.points) FROM "contact_score_items"(NEW) i), 0);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "contacts_score"
  BEFORE INSERT OR UPDATE ON "contacts"
  FOR EACH ROW EXECUTE FUNCTION "contacts_score"();

-- 跟进变化时重算相关线索与客户（取代只处理线索的旧触发器）
-- activity changes rescore the linked leads and accounts (replaces the lead-only trigger)
DROP TRIGGER "activities_rescore_leads" ON "activities";
DROP FUNCTION "activities_rescore_leads"();

CREATE FUNCTION "activities_rescore"() RETURNS trigger AS $$
BEGIN
  -- 原关联（更新时含完成状态变化）/ the previous links (on update this also covers completion changes)
  IF TG_OP <> 'INSERT' THEN
    IF OLD."lead_id" IS NOT NULL THEN UPDATE "leads" SET "score" = "score" WHERE "id" = OLD."lead_id"; END IF;
    IF OLD."account_id" IS NOT NULL THEN UPDATE "accounts" SET "score" = "score" WHERE "id" = OLD."account_id"; END IF;
  END IF;
  -- 新关联 / the new links
  IF TG_OP <> 'DELETE' THEN
    IF NEW."lead_id" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."lead_id" IS DISTINCT FROM OLD."lead_id") THEN
      UPDATE "leads" SET "score" = "score" WHERE "id" = NEW."lead_id";
    END IF;
    IF NEW."account_id" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."account_id" IS DISTINCT FROM OLD."account_id") THEN
      UPDATE "accounts" SET "score" = "score" WHERE "id" = NEW."account_id";
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "activities_rescore"
  AFTER INSERT OR DELETE OR UPDATE OF "lead_id", "account_id", "completed" ON "activities"
  FOR EACH ROW EXECUTE FUNCTION "activities_rescore"();

-- 联系人新增、删除、换客户时重算客户 / contact changes rescore their accounts
CREATE FUNCTION "contacts_rescore_account"() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN UPDATE "accounts" SET "score" = "score" WHERE "id" = OLD."account_id"; END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW."account_id" IS DISTINCT FROM OLD."account_id") THEN
    UPDATE "accounts" SET "score" = "score" WHERE "id" = NEW."account_id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "contacts_rescore_account"
  AFTER INSERT OR DELETE OR UPDATE OF "account_id" ON "contacts"
  FOR EACH ROW EXECUTE FUNCTION "contacts_rescore_account"();

-- 商机新增、删除、改阶段或客户时重算客户 / deal changes rescore their accounts
CREATE FUNCTION "deals_rescore_account"() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN UPDATE "accounts" SET "score" = "score" WHERE "id" = OLD."account_id"; END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW."account_id" IS DISTINCT FROM OLD."account_id") THEN
    UPDATE "accounts" SET "score" = "score" WHERE "id" = NEW."account_id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "deals_rescore_account"
  AFTER INSERT OR DELETE OR UPDATE OF "stage", "account_id" ON "deals"
  FOR EACH ROW EXECUTE FUNCTION "deals_rescore_account"();

-- 商机联系人角色变化时重算联系人 / deal contact role changes rescore the contacts
CREATE FUNCTION "deal_roles_rescore_contact"() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN UPDATE "contacts" SET "score" = "score" WHERE "id" = OLD."contact_id"; END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW."contact_id" IS DISTINCT FROM OLD."contact_id") THEN
    UPDATE "contacts" SET "score" = "score" WHERE "id" = NEW."contact_id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "deal_roles_rescore_contact"
  AFTER INSERT OR DELETE OR UPDATE OF "role", "contact_id" ON "deal_contact_roles"
  FOR EACH ROW EXECUTE FUNCTION "deal_roles_rescore_contact"();
