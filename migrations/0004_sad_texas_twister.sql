CREATE TABLE `userTokens` (
	`slack_id` text PRIMARY KEY NOT NULL,
	`token` text,
	`pending_channel_id` text,
	`pending_ts` text,
	`pending_at` integer
);
