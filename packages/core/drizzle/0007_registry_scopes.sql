ALTER TABLE `registry_entries` ADD `scopes` text;--> statement-breakpoint
-- Registry entries described their type as `domain`; it is now one of the plugin's declared scopes.
UPDATE `registry_entries` SET `scopes` = json_object('domain', `domain`) WHERE `domain` IS NOT NULL;
