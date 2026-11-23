-- CreateEnum
CREATE TYPE "cadence_status" AS ENUM ('ACTIVE', 'COMPLETED', 'EXITED', 'STOPPED');

-- CreateTable
CREATE TABLE "cadences" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "entity" "workflow_entity" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "steps" JSONB NOT NULL,
    "exit_states" JSONB NOT NULL DEFAULT '[]',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cadences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cadence_enrollments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "cadence_id" UUID NOT NULL,
    "lead_id" UUID,
    "deal_id" UUID,
    "status" "cadence_status" NOT NULL DEFAULT 'ACTIVE',
    "current_step" INTEGER NOT NULL DEFAULT 0,
    "next_due_at" TIMESTAMPTZ(6),
    "enrolled_by_id" UUID NOT NULL,
    "enrolled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "end_reason" VARCHAR(30),

    CONSTRAINT "cadence_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cadences_organization_id_entity_idx" ON "cadences"("organization_id", "entity");

-- CreateIndex
CREATE UNIQUE INDEX "cadences_organization_id_id_key" ON "cadences"("organization_id", "id");

-- CreateIndex
CREATE INDEX "cadence_enrollments_status_next_due_at_idx" ON "cadence_enrollments"("status", "next_due_at");

-- CreateIndex
CREATE INDEX "cadence_enrollments_organization_id_cadence_id_status_idx" ON "cadence_enrollments"("organization_id", "cadence_id", "status");

-- CreateIndex
CREATE INDEX "cadence_enrollments_organization_id_lead_id_idx" ON "cadence_enrollments"("organization_id", "lead_id");

-- CreateIndex
CREATE INDEX "cadence_enrollments_organization_id_deal_id_idx" ON "cadence_enrollments"("organization_id", "deal_id");

-- AddForeignKey
ALTER TABLE "cadences" ADD CONSTRAINT "cadences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cadences" ADD CONSTRAINT "cadences_organization_id_created_by_id_fkey" FOREIGN KEY ("organization_id", "created_by_id") REFERENCES "users"("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cadence_enrollments" ADD CONSTRAINT "cadence_enrollments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cadence_enrollments" ADD CONSTRAINT "cadence_enrollments_organization_id_cadence_id_fkey" FOREIGN KEY ("organization_id", "cadence_id") REFERENCES "cadences"("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cadence_enrollments" ADD CONSTRAINT "cadence_enrollments_organization_id_lead_id_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cadence_enrollments" ADD CONSTRAINT "cadence_enrollments_organization_id_deal_id_fkey" FOREIGN KEY ("organization_id", "deal_id") REFERENCES "deals"("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cadence_enrollments" ADD CONSTRAINT "cadence_enrollments_organization_id_enrolled_by_id_fkey" FOREIGN KEY ("organization_id", "enrolled_by_id") REFERENCES "users"("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;




-- 手工约束 / Hand-written constraints
-- 节奏：名称非空白且同组织内不重复（不分大小写、去首尾空格）；步骤为 1–10 个的数组；退出状态为数组
-- cadences: non-blank names unique per organization (case-insensitive, trimmed); 1–10 steps; exit states an array
ALTER TABLE "cadences" ADD CONSTRAINT "cadences_check" CHECK (
  btrim("name") <> ''
  AND jsonb_typeof("steps") = 'array' AND jsonb_array_length("steps") BETWEEN 1 AND 10
  AND jsonb_typeof("exit_states") = 'array' AND jsonb_array_length("exit_states") <= 10
);
CREATE UNIQUE INDEX "cadences_organization_id_name_key" ON "cadences"("organization_id", lower(btrim("name")));

-- 参与：恰好关联线索或商机之一；进行中必有下一步到期时间、没有结束信息，结束后相反；步骤序号非负
-- enrollments: exactly one of lead or deal; active ones have a due time and no end data, ended ones the opposite
ALTER TABLE "cadence_enrollments" ADD CONSTRAINT "cadence_enrollments_check" CHECK (
  (("lead_id" IS NOT NULL)::int + ("deal_id" IS NOT NULL)::int) = 1
  AND "current_step" >= 0
  AND (("status" = 'ACTIVE') = ("next_due_at" IS NOT NULL))
  AND (("status" = 'ACTIVE') = ("ended_at" IS NULL))
  AND (("status" = 'ACTIVE') = ("end_reason" IS NULL))
);
-- 同一记录在同一节奏中最多一个进行中的参与 / at most one active enrollment per record and cadence
CREATE UNIQUE INDEX "cadence_enrollments_active_lead" ON "cadence_enrollments"("cadence_id", "lead_id") WHERE "status" = 'ACTIVE' AND "lead_id" IS NOT NULL;
CREATE UNIQUE INDEX "cadence_enrollments_active_deal" ON "cadence_enrollments"("cadence_id", "deal_id") WHERE "status" = 'ACTIVE' AND "deal_id" IS NOT NULL;
