DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_folder_id_folders_id_fk" FOREIGN KEY ("parent_folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignments_user_scope_idx" ON "assignments" USING btree ("user_id","scope_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignments_role_idx" ON "assignments" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignments_org_idx" ON "assignments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_org_idx" ON "documents" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_folder_idx" ON "documents" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "folders_org_idx" ON "folders" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "folders_parent_idx" ON "folders" USING btree ("parent_folder_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "role_permissions_permission_idx" ON "role_permissions" USING btree ("permission_id");--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_scope_type_check" CHECK ("assignments"."scope_type" in ('organization','folder','document'));--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_key_check" CHECK ("permissions"."key" in ('can_view','can_edit','can_comment','can_submit','can_approve','can_view_history','can_share','can_manage_members','can_manage_policy','can_transfer_ownership','can_delete'));--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_name_check" CHECK ("roles"."name" in ('owner','approver','editor','viewer'));