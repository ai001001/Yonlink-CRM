-- CreateEnum
CREATE TYPE "kb_article_status" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "kb_articles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "category" VARCHAR(50),
    "status" "kb_article_status" NOT NULL DEFAULT 'DRAFT',
    "author_id" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "kb_articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_articles" (
    "organization_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "linked_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_articles_pkey" PRIMARY KEY ("ticket_id","article_id")
);

-- CreateIndex
CREATE INDEX "kb_articles_organization_id_status_updated_at_idx" ON "kb_articles"("organization_id", "status", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "kb_articles_organization_id_category_idx" ON "kb_articles"("organization_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "kb_articles_organization_id_id_key" ON "kb_articles"("organization_id", "id");

-- CreateIndex
CREATE INDEX "ticket_articles_organization_id_article_id_idx" ON "ticket_articles"("organization_id", "article_id");

-- AddForeignKey
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_organization_id_author_id_fkey" FOREIGN KEY ("organization_id", "author_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticket_articles" ADD CONSTRAINT "ticket_articles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_articles" ADD CONSTRAINT "ticket_articles_organization_id_ticket_id_fkey" FOREIGN KEY ("organization_id", "ticket_id") REFERENCES "tickets"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_articles" ADD CONSTRAINT "ticket_articles_organization_id_article_id_fkey" FOREIGN KEY ("organization_id", "article_id") REFERENCES "kb_articles"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_articles" ADD CONSTRAINT "ticket_articles_organization_id_linked_by_id_fkey" FOREIGN KEY ("organization_id", "linked_by_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- 手工约束 / Hand-written constraints
-- 标题非空白；正文非空白且不超过 5 万字；分类非空白（可为空）；已发布、已归档必须有发布时间；浏览数非负
-- non-blank title; non-blank body up to 50,000 chars; non-blank category when set; published/archived have a publish time; non-negative views
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_text_check" CHECK (
  btrim("title") <> '' AND btrim("body") <> '' AND char_length("body") <= 50000 AND ("category" IS NULL OR btrim("category") <> '')
);
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_published_check" CHECK ("status" = 'DRAFT' OR "published_at" IS NOT NULL);
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_view_count_check" CHECK ("view_count" >= 0);
