import {
  integer,
  primaryKey,
  sqliteTable,
  text,
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

export const userTokensTable = sqliteTable("userTokens", {
  slackId: text("slack_id").primaryKey(),
  token: text("token"),
  pendingChannelId: text("pending_channel_id"),
  pendingTs: text("pending_ts"),
  pendingAt: integer("pending_at"),
});

export type Admin = typeof adminsTable.$inferSelect;
export type Ping = typeof pingsTable.$inferSelect;
export type PingPerms = typeof pingPermsTable.$inferSelect;
export type UserToken = typeof userTokensTable.$inferSelect;
