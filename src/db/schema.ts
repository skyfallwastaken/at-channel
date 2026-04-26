import {
  primaryKey,
  sqliteTable,
  text,
  integer,
} from "drizzle-orm/sqlite-core";

export const adminsTable = sqliteTable("admins", {
  userId: text("user_id").primaryKey(),
});

export const pingsTable = sqliteTable(
  "pings",
  {
    slackId: text("slack_id").notNull(),
    ts: text("ts").notNull(),
    type: text("type", { enum: ["channel", "here"] }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.slackId, table.ts] })],
);

export const pingPermsTable = sqliteTable("pingPerms", {
  slackId: text("slack_id").notNull(),
  channelId: text("channel_id").notNull(),
});

export const scheduledPingsTable = sqliteTable("scheduledPings", {
  id: text("id").primaryKey(),
  slackId: text("slack_id").notNull(),
  channelId: text("channel_id").notNull(),
  message: text("message").notNull(),
  type: text("type", { enum: ["channel", "here"] }).notNull(),
  scheduledTime: integer("scheduled_time", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export type Admin = typeof adminsTable.$inferSelect;
export type Ping = typeof pingsTable.$inferSelect;
export type PingPerms = typeof pingPermsTable.$inferSelect;
export type ScheduledPing = typeof scheduledPingsTable.$inferSelect;
