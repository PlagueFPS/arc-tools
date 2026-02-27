CREATE TABLE `twitch_channels` (
	`broadcaster_id` text PRIMARY KEY NOT NULL,
	`broadcaster_login` text NOT NULL,
	`joined_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `twitch_tokens` (
	`user_id` text PRIMARY KEY NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`expires_in` integer,
	`obtainment_timestamp` integer NOT NULL,
	`scope_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
