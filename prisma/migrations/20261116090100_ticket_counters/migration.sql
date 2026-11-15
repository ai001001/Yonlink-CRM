-- CreateTable
CREATE TABLE "ticket_counters" (
    "organization_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "last" INTEGER NOT NULL,

    CONSTRAINT "ticket_counters_pkey" PRIMARY KEY ("organization_id","year")
);

-- AddForeignKey
ALTER TABLE "ticket_counters" ADD CONSTRAINT "ticket_counters_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 手工约束 / Hand-written constraints
ALTER TABLE "ticket_counters" ADD CONSTRAINT "ticket_counters_last_check" CHECK ("last" > 0 AND "year" BETWEEN 2000 AND 9999);
