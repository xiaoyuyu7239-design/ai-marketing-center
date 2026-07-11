CREATE TYPE "public"."saas_project_content_type" AS ENUM('product', 'topic');--> statement-breakpoint
CREATE TYPE "public"."saas_project_status" AS ENUM('draft', 'scripting', 'assets', 'video', 'composing', 'done');--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "saas_project_status" DEFAULT 'draft' NOT NULL,
	"content_type" "saas_project_content_type" DEFAULT 'product' NOT NULL,
	"topic" text,
	"product_name" text,
	"product_category" text,
	"product_description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_name_length_check" CHECK (char_length(btrim("projects"."name")) between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_workspace_id_id_unique" ON "projects" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "projects_workspace_created_index" ON "projects" USING btree ("workspace_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "projects_workspace_isolation" ON "projects" AS PERMISSIVE FOR ALL TO public USING ("projects"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("projects"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);