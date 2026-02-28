CREATE TABLE `twitch_tokens` (
	`id` integer PRIMARY KEY NOT NULL,
	`bot_user_id` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`expires_in` integer,
	`obtainment_timestamp` integer NOT NULL,
	`scope` text NOT NULL,
	`updated_at` integer
);
