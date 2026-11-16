-- AlterEnum
ALTER TYPE "notification_type" ADD VALUE 'TICKET_COMMENT';

-- CreateTable
CREATE TABLE "ticket_comments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "is_internal" BOOLEAN NOT NULL DEFAULT false,
    "edited_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ticket_comments_organization_id_ticket_id_created_at_idx" ON "ticket_comments"("organization_id", "ticket_id", "created_at");

-- AddForeignKey
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_organization_id_ticket_id_fkey" FOREIGN KEY ("organization_id", "ticket_id") REFERENCES "tickets"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_organization_id_author_id_fkey" FOREIGN KEY ("organization_id", "author_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- 手工约束 / Hand-written constraints
-- 评论内容非空白且不超过 5000 字 / comments are non-blank and at most 5000 characters
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_body_check" CHECK (btrim("body") <> '' AND char_length("body") <= 5000);
