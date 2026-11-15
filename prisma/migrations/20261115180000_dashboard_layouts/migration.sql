-- CreateTable
CREATE TABLE "user_dashboard_layouts" (
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "widgets" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_dashboard_layouts_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_dashboard_layouts_organization_id_user_id_key" ON "user_dashboard_layouts"("organization_id", "user_id");

-- AddForeignKey
ALTER TABLE "user_dashboard_layouts" ADD CONSTRAINT "user_dashboard_layouts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_dashboard_layouts" ADD CONSTRAINT "user_dashboard_layouts_organization_id_user_id_fkey" FOREIGN KEY ("organization_id", "user_id") REFERENCES "users"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 手工约束 / Hand-written constraints
-- 卡片列表必须是 JSON 数组 / the widget list must be a JSON array
ALTER TABLE "user_dashboard_layouts" ADD CONSTRAINT "user_dashboard_layouts_widgets_check" CHECK (jsonb_typeof("widgets") = 'array');
