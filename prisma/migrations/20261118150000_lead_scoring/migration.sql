-- CreateEnum
CREATE TYPE "lead_scoring_rule_kind" AS ENUM ('FIELD_EQUALS', 'FIELD_FILLED', 'ACTIVITY_COUNT');

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "score" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "lead_scoring_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" "lead_scoring_rule_kind" NOT NULL,
    "field" VARCHAR(30),
    "value" VARCHAR(50),
    "points" INTEGER NOT NULL,
    "max_count" INTEGER,
    "position" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "lead_scoring_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_scoring_settings" (
    "organization_id" UUID NOT NULL,
    "hot_score" INTEGER NOT NULL DEFAULT 60,
    "warm_score" INTEGER NOT NULL DEFAULT 30,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "lead_scoring_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateIndex
CREATE INDEX "lead_scoring_rules_organization_id_position_idx" ON "lead_scoring_rules"("organization_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "lead_scoring_rules_organization_id_id_key" ON "lead_scoring_rules"("organization_id", "id");

-- CreateIndex
CREATE INDEX "leads_organization_id_score_idx" ON "leads"("organization_id", "score" DESC);

-- AddForeignKey
ALTER TABLE "lead_scoring_rules" ADD CONSTRAINT "lead_scoring_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_scoring_settings" ADD CONSTRAINT "lead_scoring_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- 手工约束 / Hand-written constraints
-- 规则：分值 -100–100 且非 0；字段与取值按类型限定在固定集合；跟进数规则上限 1–50
-- rules: points in -100..100 and non-zero; fields and values from fixed sets per kind; activity cap 1..50
ALTER TABLE "lead_scoring_rules" ADD CONSTRAINT "lead_scoring_rules_check" CHECK (
  "points" BETWEEN -100 AND 100 AND "points" <> 0 AND "position" >= 0
  AND (
    ("kind" = 'FIELD_EQUALS' AND "max_count" IS NULL AND (
      ("field" = 'source' AND "value" IN ('WEBSITE', 'REFERRAL', 'EXHIBITION', 'COLD_CALL', 'ADVERTISEMENT', 'SOCIAL_MEDIA', 'OTHER'))
      OR ("field" = 'status' AND "value" IN ('NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED'))
    ))
    OR ("kind" = 'FIELD_FILLED' AND "value" IS NULL AND "max_count" IS NULL
      AND "field" IN ('company', 'title', 'email', 'phone', 'mobile', 'description', 'campaign', 'web_form'))
    OR ("kind" = 'ACTIVITY_COUNT' AND "field" IS NULL AND "value" IS NULL AND "max_count" BETWEEN 1 AND 50)
  )
);
-- 分级阈值：0 ≤ 温和 < 热门 ≤ 1000 / thresholds: 0 <= warm < hot <= 1000
ALTER TABLE "lead_scoring_settings" ADD CONSTRAINT "lead_scoring_settings_check" CHECK ("warm_score" >= 0 AND "hot_score" > "warm_score" AND "hot_score" <= 1000);

-- 线索命中的规则与得分（只用固定字段，不拼接 SQL）；跟进数规则按已完成跟进计数，得 0 分的不返回
-- the rules a lead matches and their points (fixed fields only, no dynamic SQL); activity rules count completed
-- activities and are omitted when they score 0
CREATE FUNCTION "lead_score_items"(l "leads") RETURNS TABLE ("rule_id" uuid, "points" integer) LANGUAGE sql STABLE AS $$
  SELECT x.id, x.points FROM (
    SELECT r.id, r.position,
      CASE WHEN r.kind = 'ACTIVITY_COUNT'
        THEN r.points * LEAST(r.max_count, (
          SELECT count(*) FROM "activities" a WHERE a.organization_id = l.organization_id AND a.lead_id = l.id AND a.completed
        ))::integer
        ELSE r.points END AS points
    FROM "lead_scoring_rules" r
    WHERE r.organization_id = l.organization_id AND r.is_active AND (
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

-- 线索写入时计算分数（任何写入途径都不会遗漏，客户端写入的分数会被覆盖）
-- compute the score on every lead write (no write path can skip it; client-supplied scores are overwritten)
CREATE FUNCTION "leads_score"() RETURNS trigger AS $$
BEGIN
  NEW."score" := coalesce((SELECT sum(i.points) FROM "lead_score_items"(NEW) i), 0);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "leads_score"
  BEFORE INSERT OR UPDATE ON "leads"
  FOR EACH ROW EXECUTE FUNCTION "leads_score"();

-- 跟进新增、删除、改关联线索或完成状态时重算相关线索 / recompute the linked leads when activities change
CREATE FUNCTION "activities_rescore_leads"() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD."lead_id" IS NOT NULL THEN
    UPDATE "leads" SET "score" = "score" WHERE "id" = OLD."lead_id";
  END IF;
  IF TG_OP <> 'DELETE' AND NEW."lead_id" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."lead_id" IS DISTINCT FROM OLD."lead_id" OR NEW."completed" IS DISTINCT FROM OLD."completed") THEN
    UPDATE "leads" SET "score" = "score" WHERE "id" = NEW."lead_id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "activities_rescore_leads"
  AFTER INSERT OR DELETE OR UPDATE OF "lead_id", "completed" ON "activities"
  FOR EACH ROW EXECUTE FUNCTION "activities_rescore_leads"();
