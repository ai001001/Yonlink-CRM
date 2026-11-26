-- 标准字段可配置（#65）：线索来源与行业可有自定义选项，评分规则中这两个字段的值改为只检查代码格式
-- （选项是否存在由应用按组织配置检查）；其余条件不变。
-- Configurable picklists (#65): lead source and industry may hold custom options, so scoring rules only check the code
-- format for these two fields (existence is checked by the application against the organization's setup); the rest
-- is unchanged.
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
        ("field" = 'source' AND "value" ~ '^[A-Z][A-Z0-9_]{0,29}$')
        OR ("field" = 'status' AND "value" IN ('NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED'))))
      OR ("kind" = 'FIELD_FILLED' AND "value" IS NULL AND "field" IN ('company', 'title', 'email', 'phone', 'mobile', 'description', 'campaign', 'web_form'))
      OR ("kind" = 'ACTIVITY_COUNT' AND "field" IS NULL)
    WHEN 'ACCOUNT' THEN
      ("kind" = 'FIELD_EQUALS' AND "field" = 'industry' AND "value" ~ '^[A-Z][A-Z0-9_]{0,29}$')
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
