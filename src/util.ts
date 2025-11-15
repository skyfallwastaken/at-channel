import pino from "pino";
import type Slack from "@slack/bolt";
import { stripIndents } from "common-tags";
import { adminsTable, db, pingPermsTable } from "./db";
import { and, eq } from "drizzle-orm";
import { env } from "./env";

export const logger = pino({
  level: env.LOG_LEVEL,
});

export async function hasPerms(
  userId: string,
  channelId: string,
  client: Slack.webApi.WebClient,
): Promise<boolean> {
  const [admin] = await db
    .select()
    .from(adminsTable)
    .where(eq(adminsTable.userId, userId));
  const channelManagers = await getChannelManagers(channelId);
  const hasPermsEntry = await db
    .select()
    .from(pingPermsTable)
    .where(
      and(
        eq(pingPermsTable.slackId, userId),
        eq(pingPermsTable.channelId, channelId),
      ),
    );

  const isChannelCreator =
    (await getChannelCreator(channelId, client)) === userId;

  if (admin != null || channelManagers.includes(userId) || isChannelCreator) {
    if (hasPermsEntry.length === 0) {
      await db.insert(pingPermsTable).values({
        slackId: userId,
        channelId: channelId,
      });
    }
    return true;
  }

  return hasPermsEntry.length > 0;
}

export async function getChannelManagers(channelId: string): Promise<string[]> {
  const formData = new FormData();
  formData.append("token", env.SLACK_XOXC || "");
  formData.append("entity_id", channelId);

  const request = await fetch(
    "https://slack.com/api/admin.roles.entity.listAssignments",
    {
      method: "POST",
      body: formData,
      headers: {
        Cookie: `d=${encodeURIComponent(env.SLACK_XOXD)}`,
      },
    },
  );

  const json = await request.json();

  if (!json.ok) return [];
  return json.role_assignments[0]?.users || [];
}

export async function getChannelCreator(
  channelId: string,
  client: Slack.webApi.WebClient,
): Promise<string | null> {
  const channelInfo = await client.conversations.info({
    channel: channelId,
  });
  return channelInfo?.channel?.creator || null;
}

export function generateRandomString(length: number) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function generatePingErrorMessage(
  rayId: string,
  type: "channel" | "here",
  message: string,
  userId: string,
  botId: string,
  error: unknown,
) {
  logger.error(`Generating error message for ray ID ${rayId}: ${error}`);
  const escapedMessage = message.replace("`", "`");

  if (error?.toString?.().includes("channel_not_found")) {
    return stripIndents`
      :tw_warning: *Hey <@${userId}>!* Looks like this is a private channel, so you'll need to add me (<@${botId}>) to the channel and try the command again.
      For reference, your message was \`${escapedMessage}\`.
    `.trim();
  }

  return stripIndents`
    :tw_warning: *Hey <@${userId}>!* Unfortunately, I wasn't able to send your @${type} ping with message \`${escapedMessage}\`.
    Please DM <@U059VC0UDEU> so this can be fixed! Make sure to include the Ray ID (\`${rayId}\`) in your message. Thank you! :yay:
    Error was:
    \`\`\`
    ${error?.toString?.()}
    \`\`\`
  `.trim();
}

export function generateDeletePingErrorMessage(rayId: string, error: unknown) {
  return stripIndents`
  :tw_warning: Unfortunately, I wasn't able to delete your ping :pensive-hole:
  Please DM <@U059VC0UDEU> with your Ray ID (\`${rayId}\`) and the error message below.
  \`\`\`
  ${error?.toString?.()}
  \`\`\`
  `.trim();
}

export function generatePermissionChangeErrorMessage(
  rayId: string,
  error: unknown,
) {
  return stripIndents`
  :tw_warning: Unfortunately, I wasn't able to change the permissions of this channel. Please DM <@U059VC0UDEU> with your Ray ID (\`${rayId}\`) and the error message below:
  \`\`\`
  ${error?.toString?.()}
  \`\`\`
  `.trim();
}
export function generateListChannelPingersErrorMessage(
  rayId: string,
  error: unknown,
) {
  return stripIndents`
  :tw_warning: Unfortunately, I wasn't able to list the channel pingers. Please DM <@U059VC0UDEU> with your Ray ID (\`${rayId}\`) and the error message below:
  \`\`\`
  ${error?.toString?.()}
  \`\`\`
  `.trim();
}

export function generateLeaderboardErrorMessage(
  rayId: string,
  error: unknown,
) {
  return stripIndents`
  :tw_warning: Unfortunately, I wasn't able to fetch the leaderboard. Please DM <@U059VC0UDEU> with your Ray ID (\`${rayId}\`) and the error message below:
  \`\`\`
  ${error?.toString?.()}
  \`\`\`
  `.trim();
}

export const CHANNEL_COMMAND_NAME =
  env.NODE_ENV === "development" ? "/dev-channel" : "/channel";
export const HERE_COMMAND_NAME =
  env.NODE_ENV === "development" ? "/dev-here" : "/here";
export const ADD_CHANNEL_PERMS_NAME =
  env.NODE_ENV === "development"
    ? "/dev-add-channel-perms"
    : "/add-channel-perms";
export const REMOVE_CHANNEL_PERMS_NAME =
  env.NODE_ENV === "development"
    ? "/dev-remove-channel-perms"
    : "/remove-channel-perms";
export const LIST_CHANNEL_PERMS_HAVERS_NAME =
  env.NODE_ENV === "development"
    ? "/dev-list-channel-pingers"
    : "/list-channel-pingers";
export const AT_CHANNEL_LEADERBOARD_NAME =
  env.NODE_ENV === "development"
    ? "/dev-at-channel-leaderboard"
    : "/at-channel-leaderboard";
