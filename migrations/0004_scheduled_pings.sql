CREATE TABLE `scheduledPings` (
	`id` text PRIMARY KEY NOT NULL,
	`slack_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`message` text NOT NULL,
	`type` text NOT NULL,
	`scheduled_time` integer NOT NULL,
	`created_at` integer NOT NULL
);
