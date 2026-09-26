ALTER TABLE `mcp_tokens` ADD `access` text DEFAULT 'read' NOT NULL;--> statement-breakpoint
ALTER TABLE `oauth_grants` ADD `access` text DEFAULT 'read' NOT NULL;--> statement-breakpoint
ALTER TABLE `operations` ADD `level_override` text;--> statement-breakpoint
-- Tokens and grants issued before access ceilings existed keep their read & write reach.
UPDATE `mcp_tokens` SET `access` = 'write';--> statement-breakpoint
UPDATE `oauth_grants` SET `access` = 'write';--> statement-breakpoint
-- Exclusions become an explicit `none` level.
UPDATE `operations` SET `level_override` = 'none' WHERE `excluded` = 1;--> statement-breakpoint
-- Opted-in locked ops were callable (with approval) only while their group was at `write`.
UPDATE `operations` SET `level_override` = 'ask'
  WHERE `locked_opt_in` = 1 AND `excluded` = 0
    AND `group_id` IN (SELECT `id` FROM `operation_groups` WHERE `level` = 'write');--> statement-breakpoint
-- The old `write` level asked for approval on every write: that is now `ask`. Nothing starts auto-running.
UPDATE `operation_groups` SET `level` = 'ask' WHERE `level` = 'write';--> statement-breakpoint
-- Approvals decided in the removed portal inbox or via notification links were all made on a signed-in page.
UPDATE `pending_approvals` SET `decided_via` = 'url' WHERE `decided_via` IN ('portal', 'link');
