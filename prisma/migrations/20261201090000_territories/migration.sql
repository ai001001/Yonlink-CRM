-- CreateEnum
CREATE TYPE "territory_match" AS ENUM ('ALL', 'ANY');

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "territory_id" UUID,
ADD COLUMN     "territory_manual" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "territories" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "manager_id" UUID,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "match" "territory_match" NOT NULL DEFAULT 'ALL',
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "territories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "territory_members" (
    "organization_id" UUID NOT NULL,
    "territory_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "territory_members_pkey" PRIMARY KEY ("territory_id","user_id")
);

-- CreateIndex
CREATE INDEX "territories_organization_id_parent_id_idx" ON "territories"("organization_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "territories_organization_id_id_key" ON "territories"("organization_id", "id");

-- CreateIndex
CREATE INDEX "territory_members_organization_id_user_id_idx" ON "territory_members"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "accounts_organization_id_territory_id_idx" ON "accounts"("organization_id", "territory_id");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_organization_id_territory_id_fkey" FOREIGN KEY ("organization_id", "territory_id") REFERENCES "territories"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "territories" ADD CONSTRAINT "territories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "territories" ADD CONSTRAINT "territories_organization_id_parent_id_fkey" FOREIGN KEY ("organization_id", "parent_id") REFERENCES "territories"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "territories" ADD CONSTRAINT "territories_organization_id_manager_id_fkey" FOREIGN KEY ("organization_id", "manager_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "territory_members" ADD CONSTRAINT "territory_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "territory_members" ADD CONSTRAINT "territory_members_organization_id_territory_id_fkey" FOREIGN KEY ("organization_id", "territory_id") REFERENCES "territories"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "territory_members" ADD CONSTRAINT "territory_members_organization_id_user_id_fkey" FOREIGN KEY ("organization_id", "user_id") REFERENCES "users"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;




-- 手工约束 / Hand-written constraints
-- 名称非空白且同组织内不重复（不分大小写）；优先级 1–999；条件为数组、最多 10 条；不能以自己为上级
-- non-blank names unique per organization (case-insensitive); priority 1–999; conditions an array of at most 10; not its own parent
ALTER TABLE "territories" ADD CONSTRAINT "territories_check" CHECK (
  btrim("name") <> '' AND "priority" BETWEEN 1 AND 999
  AND jsonb_typeof("conditions") = 'array' AND jsonb_array_length("conditions") <= 10
  AND ("parent_id" IS NULL OR "parent_id" <> "id")
);
CREATE UNIQUE INDEX "territories_organization_id_name_key" ON "territories"("organization_id", lower(btrim("name")));

-- 树形守卫：不能形成环，层级（含下级）不超过 3 级 / tree guard: no cycles, at most 3 levels including descendants
CREATE FUNCTION "territories_tree_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  depth int := 1;
  height int;
  cur uuid := NEW."parent_id";
BEGIN
  WHILE cur IS NOT NULL LOOP
    IF cur = NEW."id" THEN
      RAISE EXCEPTION 'territory cycle' USING ERRCODE = 'check_violation', CONSTRAINT = 'territories_tree_check';
    END IF;
    depth := depth + 1;
    SELECT "parent_id" INTO cur FROM "territories" WHERE "id" = cur;
  END LOOP;
  WITH RECURSIVE sub AS (
    SELECT "id", 1 AS lvl FROM "territories" WHERE "parent_id" = NEW."id"
    UNION ALL
    SELECT t."id", sub.lvl + 1 FROM "territories" t JOIN sub ON t."parent_id" = sub."id" WHERE sub.lvl < 5
  )
  SELECT coalesce(max(lvl), 0) INTO height FROM sub;
  IF depth + height > 3 THEN
    RAISE EXCEPTION 'territory tree too deep' USING ERRCODE = 'check_violation', CONSTRAINT = 'territories_tree_check';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "territories_tree_guard" BEFORE INSERT OR UPDATE OF "parent_id" ON "territories"
  FOR EACH ROW EXECUTE FUNCTION "territories_tree_guard"();
