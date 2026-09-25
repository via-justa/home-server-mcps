CREATE TABLE `approval_links` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`approval_id` text NOT NULL,
	`action` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`approval_id`) REFERENCES `pending_approvals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`instance_id` text,
	`operation_key` text,
	`classification` text,
	`decision` text,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`decided_by` text,
	`decided_via` text,
	`params` text,
	`resolved_targets` text,
	`result_status` text,
	`duration_ms` integer,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `audit_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `audit_instance_at_idx` ON `audit_log` (`instance_id`,`at`);--> statement-breakpoint
CREATE TABLE `guides` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`version` text NOT NULL,
	`content` text NOT NULL,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `plugin_instances`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mcp_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`scope` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_tokens_token_hash_unique` ON `mcp_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `notifier_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`secrets_enc` blob,
	`events` text NOT NULL,
	`instance_filter` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_sent_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_hash` text,
	`name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`registered_via` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_clients_client_id_unique` ON `oauth_clients` (`client_id`);--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`code_challenge` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`resources` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`grant_id`) REFERENCES `oauth_grants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`resources` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`kind` text NOT NULL,
	`family_id` text NOT NULL,
	`resources` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`grant_id`) REFERENCES `oauth_grants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oidc_config` (
	`id` integer PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_enc` blob,
	`scopes` text DEFAULT 'openid email profile' NOT NULL,
	`allow_policy` text,
	`auto_provision` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`key` text NOT NULL,
	`display_name` text,
	`kind` text NOT NULL,
	`tag` text,
	`classification` text NOT NULL,
	`classification_source` text NOT NULL,
	`inferred_classification` text NOT NULL,
	`inferred_reason` text NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`typed_confirmation` integer DEFAULT false NOT NULL,
	`attestation_required` integer DEFAULT false NOT NULL,
	`needs_review` integer DEFAULT false NOT NULL,
	`match_profile` text,
	`params_schema` text,
	`docs` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`stale` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `plugin_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operations_instance_key_idx` ON `operations` (`instance_id`,`key`);--> statement-breakpoint
CREATE TABLE `pending_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`params_display` text,
	`params_hash` text NOT NULL,
	`resolved_targets` text,
	`summary` text NOT NULL,
	`confirm_literal` text,
	`diff` text,
	`expected_hash` text,
	`client_kind` text,
	`client_id` text,
	`mcp_session_id` text,
	`requested_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decided_via` text,
	`decided_at` integer,
	FOREIGN KEY (`instance_id`) REFERENCES `plugin_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `plugin_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`secrets_enc` blob,
	`auth_mode` text,
	`settings` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'stopped' NOT NULL,
	`status_error` text,
	`upstream_version` text,
	`source_ref` text,
	`last_synced_at` integer,
	`last_sync_status` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugins`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_instances_slug_unique` ON `plugin_instances` (`slug`);--> statement-breakpoint
CREATE TABLE `plugin_repos` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`name` text,
	`signing_mode` text NOT NULL,
	`public_key` text,
	`key_fingerprint` text,
	`key_status` text DEFAULT 'ok' NOT NULL,
	`index_cache` text,
	`last_fetched_at` integer,
	`last_fetch_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_repos_url_unique` ON `plugin_repos` (`url`);--> statement-breakpoint
CREATE TABLE `plugins` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`version` text NOT NULL,
	`source` text NOT NULL,
	`repo_id` text,
	`path` text NOT NULL,
	`sha256` text,
	`signature_verified` integer DEFAULT false NOT NULL,
	`manifest` text NOT NULL,
	`status` text NOT NULL,
	`status_error` text,
	`enabled` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `plugin_repos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugins_plugin_id_unique` ON `plugins` (`plugin_id`);--> statement-breakpoint
CREATE TABLE `pre_approval_hits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rule_id` text NOT NULL,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `pre_approval_rules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hits_rule_time_idx` ON `pre_approval_hits` (`rule_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `pre_approval_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`match` text DEFAULT '[]' NOT NULL,
	`rate_limit` integer,
	`window_seconds` integer,
	`expires_at` integer,
	`reason` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer,
	`last_triggered_at` integer,
	FOREIGN KEY (`instance_id`) REFERENCES `plugin_instances`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `registry_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`kind` text NOT NULL,
	`ext_id` text NOT NULL,
	`name` text NOT NULL,
	`parent_ext_id` text,
	`domain` text,
	`attrs` text,
	`stale` integer DEFAULT false NOT NULL,
	`last_synced_at` integer NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `plugin_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registry_instance_kind_ext_idx` ON `registry_entries` (`instance_id`,`kind`,`ext_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text,
	`totp_secret_enc` blob,
	`totp_enabled` integer DEFAULT false NOT NULL,
	`recovery_codes_hash` text,
	`oidc_issuer` text,
	`oidc_subject` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_login_at` integer,
	`disabled` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);