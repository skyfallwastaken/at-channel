import { App, type SlackCommandMiddlewareArgs } from "@slack/bolt";
import { env } from "./env";
import {
  logger,
  generateRandomString,
  CHANNEL_COMMAND_NAME,
  HERE_COMMAND_NAME,
  generatePingErrorMessage,
  generateDeletePingErrorMessage,
  hasPerms,
  ADD_CHANNEL_PERMS_NAME,
  REMOVE_CHANNEL_PERMS_NAME,
  generatePermissionChangeErrorMessage,
  LIST_CHANNEL_PERMS_HAVERS_NAME,
  getChannelManagers,
  getChannelCreator,
  generateListChannelPingersErrorMessage,
  AT_CHANNEL_LEADERBOARD_NAME,
  generateLeaderboardErrorMessage,
} from "./util";
import { richTextBlockToMrkdwn } from "./richText";
import buildEditPingModal from "./editPingModal";
import { db, adminsTable, pingsTable, pingPermsTable } from "./db";
import { and, eq, sql } from "drizzle-orm";
import { LogSnag } from "@logsnag/node";
import type Slack from "@slack/bolt";
import { stripIndents } from "common-tags";

// LogSnag is used to check that pings are actually getting sent
// Ping contents aren't stored
const logsnag = new LogSnag({
  token: env.LOGSNAG_TOKEN,
  project: env.LOGSNAG_PROJECT,
});

const app = new App({
  appToken: env.SLACK_APP_TOKEN,
  token: env.SLACK_BOT_TOKEN,
  socketMode: true,
});
const botId = (
  await app.client.auth.test({
    token: env.SLACK_BOT_TOKEN,
  })
).user_id;

async function sendPing(
  type: "channel" | "here",
  message: string,
  userId: string,
  channelId: string,
  client: Slack.webApi.WebClient,
) {
  let finalMessage: string;
  if (message.includes(`@${type}`)) {
    finalMessage = message;
  } else {
    finalMessage = `@${type} ${message}`;
  }

  const user = await client.users.info({ user: userId });
  const displayName =
    user?.user?.profile?.display_name || user?.user?.name || "<unknown>";
  const avatar =
    user?.user?.profile?.image_original || user?.user?.profile?.image_512;

  const payload = {
    text: finalMessage,
    username: displayName,
    icon_url: avatar,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: finalMessage,
        },
      },
    ],
  };

  const response = await client.chat.postMessage({
    channel: channelId,
    ...payload,
  });

  if (!response.ts) {
    throw new Error("Failed to send ping");
  }

  await Promise.all([
    db.insert(pingsTable).values({
      slackId: userId,
      ts: response.ts,
      type,
    }),
    logsnag
      .track({
        channel: "pings",
        event: "Sent ping",
        user_id: displayName,
        icon: "🔔",
        tags: {
          type,
          channel: channelId,
          ts: response.ts as string,
          user: userId,
        },
      })
      .catch(() => {}),
  ]);
}

async function pingCommand(
  pingType: "channel" | "here",
  {
    command,
    ack,
    respond,
    payload,
    client,
  }: SlackCommandMiddlewareArgs & { client: Slack.webApi.WebClient },
) {
  await ack();
  const rayId = generateRandomString(12);
  const { channel_id: channelId, user_id: userId } = command;
  const { text: message } = payload;

  try {
    if (channelId === "C09BQEC01FZ") {
      await respond({
        text: `<@${userId}> tried to ping. i'm tired boss. no pings for you.`,
        response_type: "in_channel",
      });
      return;
    }

    if (!(await hasPerms(userId, channelId, client))) {
      await respond({
        text: stripIndents`
          :tw_warning: *You need to be a channel manager to use this command.*
          If this is a private channel, you'll need to add <@${botId}> to the channel.
          _If this is incorrect, please DM <@U059VC0UDEU>._
        `.trim(),
        response_type: "ephemeral",
      });
      logger.debug(
        `${rayId}: Failed to send ping: user ${userId} not admin or channel manager`,
      );
      return;
    }

    await sendPing(pingType, message, userId, channelId, client);
  } catch (e) {
    console.log(e);
    logger.error(`${rayId}: Failed to send ping: ${e}`);
    const errorMessage = generatePingErrorMessage(
      rayId,
      pingType,
      message,
      userId,
      botId as string,
      e,
    );
    try {
      await respond({
        text: errorMessage,
        response_type: "ephemeral",
      });
    } catch {
      await client.chat.postMessage({
        channel: userId,
        text: errorMessage,
      });
    }
  }
}

async function addChannelPermsCommand({
  command,
  ack,
  respond,
  payload,
  client,
}: SlackCommandMiddlewareArgs & { client: Slack.webApi.WebClient }) {
  await ack();
  const rayId = generateRandomString(12);
  const { channel_id: channelId, user_id: userId } = command;
  const { text: target } = payload;
  const match = target.match(/^<@([UW][A-Z0-9]+)(\|[^>]+)?>$/);
  const targetId = match ? match[1] : null;

  try {
    if (await hasPerms(userId, channelId, client)) {
      if (!targetId) {
        await respond({
          text: `:tw_warning: *This is not a valid slack user!*
          Make sure to ping them, not just typing in their name!
          _If this is incorrect, please DM <@U059VC0UDEU>._`,
          response_type: "ephemeral",
        });
        return;
      }
      if (await hasPerms(targetId, channelId, client)) {
        await respond({
          text: `:tw_x: ${target} can already ping in <#${channelId}>! Silly goose, go try it!`,
        });
        return;
      } else {
        await db.insert(pingPermsTable).values({
          slackId: targetId,
          channelId: channelId,
        });
        await respond({
          text: `:tw_white_check_mark: ${target} is now allowed to ping in <#${channelId}>`,
        });

        // Notify the target user about their new permissions
        await client.chat.postMessage({
          channel: targetId,
          text: `:tw_bell: You have been granted permission to use @channel/@here in <#${channelId}> by <@${userId}>.`,
        });

        logger.info(`${userId} gave ${targetId} ping perms in ${channelId}`);
        logsnag
          .track({
            channel: "perms",
            event: "addedUser",
            user_id: userId,
            icon: "🔔",
            tags: {
              channel: channelId,
              user_id: userId,
              target_id: targetId,
            },
          })
          .catch(() => {});
        return;
      }
    } else {
      await respond({
        text: `:tw_warning: *You need to be a channel manager to use this command.*
          If this is a private channel, you'll need to add <@${botId}> to the channel.
          _If this is incorrect, please DM <@U059VC0UDEU>._`,
        response_type: "ephemeral",
      });
    }
  } catch (e) {
    console.log(e);
    logger.error(`${rayId}: Failed to add permissions: ${e}`);
    const errorMessage = generatePermissionChangeErrorMessage(rayId, e);
    try {
      await respond({
        text: errorMessage,
        response_type: "ephemeral",
      });
    } catch {
      await client.chat.postMessage({
        channel: userId,
        text: errorMessage,
      });
    }
  }
}

async function removeChannelPermsCommand({
  command,
  ack,
  respond,
  payload,
  client,
}: SlackCommandMiddlewareArgs & { client: Slack.webApi.WebClient }) {
  await ack();
  const rayId = generateRandomString(12);
  const { channel_id: channelId, user_id: userId } = command;
  const { text: target } = payload;
  const match = target.match(/^<@([UW][A-Z0-9]+)(\|[^>]+)?>$/);
  const targetId = match ? match[1] : null;

  try {
    if (await hasPerms(userId, channelId, client)) {
      if (!targetId) {
        await respond({
          text: `:tw_warning: *This is not a valid slack user!*
          Make sure to ping them, not just typing in their name!
          _If this is incorrect, please DM <@U059VC0UDEU>._`,
          response_type: "ephemeral",
        });
        return;
      }
      if (await hasPerms(targetId, channelId, client)) {
        await db
          .delete(pingPermsTable)
          .where(
            and(
              eq(pingPermsTable.slackId, targetId),
              eq(pingPermsTable.channelId, channelId),
            ),
          );
        await respond({
          text: `:tw_white_check_mark: ${target} can no longer ping in <#${channelId}>!`,
        });

        // Notify the target user that their permissions have been revoked
        await client.chat.postMessage({
          channel: targetId,
          text: `:tw_bell: Your permission to use @channel/@here in <#${channelId}> has been revoked by <@${userId}>.`,
        });

        logger.info(`${userId} removed ${targetId} ping perms in ${channelId}`);
        logsnag
          .track({
            channel: "perms",
            event: "removedUser",
            user_id: userId,
            icon: "🔔",
            tags: {
              channel: channelId,
              user_id: userId,
              target_id: targetId,
            },
          })
          .catch(() => {});
        return;
      } else {
        await respond({
          text: `:tw_warning: ${target} does not have ping permissions in <#${channelId}>!`,
        });
        return;
      }
    } else {
      await respond({
        text: `:tw_warning: *You need to be a channel manager to use this command.*
          If this is a private channel, you'll need to add <@${botId}> to the channel.
          _If this is incorrect, please DM <@U059VC0UDEU>._`,
        response_type: "ephemeral",
      });
    }
  } catch (e) {
    console.log(e);
    logger.error(`${rayId}: Failed to remove permissions: ${e}`);
    const errorMessage = generatePermissionChangeErrorMessage(rayId, e);
    try {
      await respond({
        text: errorMessage,
        response_type: "ephemeral",
      });
    } catch {
      await client.chat.postMessage({
        channel: userId,
        text: errorMessage,
      });
    }
  }
}

async function listChannelPingersCommand({
  command,
  ack,
  respond,
  client,
}: SlackCommandMiddlewareArgs & { client: Slack.webApi.WebClient }) {
  await ack();
  const rayId = generateRandomString(12);
  const { channel_id: channelId, user_id: userId } = command;

  try {
    const perms = await db
      .select()
      .from(pingPermsTable)
      .where(eq(pingPermsTable.channelId, channelId));

    const admins = await db.select().from(adminsTable);

    const channelCreator = await getChannelCreator(channelId, client);

    const channelManagers = await (async () => {
      try {
        return await getChannelManagers(channelId);
      } catch {
        return [];
      }
    })();

    const userIds = new Set<string>();
    perms.forEach((p) => userIds.add(p.slackId));
    admins.forEach((a) => userIds.add(a.userId));
    channelManagers.forEach((id) => userIds.add(id));
    if (channelCreator) {
      userIds.add(channelCreator);
    }

    const filteredUserIds = new Set(
      Array.from(userIds).filter((id): id is string => typeof id === "string"),
    );

    if (filteredUserIds.size === 0) {
      await respond({
        text: ":tw_warning: No one has permission to ping in this channel.",
        response_type: "ephemeral",
      });
      return;
    }

    const mentions = Array.from(filteredUserIds)
      .map((id) => `<@${id}>`)
      .join("\n");

    await respond({
      text: `:tw_bell: People who can use @channel/@here in <#${channelId}>:\n${mentions}`,
      response_type: "ephemeral",
    });
  } catch (e) {
    console.log(e);
    logger.error(`${rayId}: Failed to list channel pingers: ${e}`);
    const errorMessage = generateListChannelPingersErrorMessage(rayId, e);
    try {
      await respond({
        text: errorMessage,
        response_type: "ephemeral",
      });
    } catch {
      await client.chat.postMessage({
        channel: userId,
        text: errorMessage,
      });
    }
  }
}

async function leaderboardCommand({
  command,
  ack,
  respond,
  payload,
  client,
}: SlackCommandMiddlewareArgs & { client: Slack.webApi.WebClient }) {
  await ack();
  const rayId = generateRandomString(12);
  const { user_id: userId } = command;
  const { text: target } = payload;
  const trimmedTarget = target.trim();
  const match = trimmedTarget.match(/^<@([UW][A-Z0-9]+)(\|[^>]+)?>$/);
  const targetId = match ? match[1] : null;

  try {
    const leaderboard = await db
      .select({
        slackId: pingsTable.slackId,
        channelCount: sql<number>`SUM(CASE WHEN ${pingsTable.type} = 'channel' THEN 1 ELSE 0 END)`,
        hereCount: sql<number>`SUM(CASE WHEN ${pingsTable.type} = 'here' THEN 1 ELSE 0 END)`,
        totalCount: sql<number>`COUNT(*)`,
      })
      .from(pingsTable)
      .groupBy(pingsTable.slackId)
      .orderBy(sql`COUNT(*) DESC`);

    if (leaderboard.length === 0) {
      await respond({
        text: ":tw_warning: No pings have been sent yet!",
        response_type: "ephemeral",
      });
      return;
    }

    if (targetId) {
      const userRank = leaderboard.findIndex((row) => row.slackId === targetId);
      if (userRank === -1) {
        await respond({
          text: `:tw_warning: <@${targetId}> has not sent any pings yet!`,
          response_type: "ephemeral",
        });
        return;
      }

      const userStats = leaderboard[userRank];
      await respond({
        text: stripIndents`
          :tw_trophy: <@${targetId}> is ranked #${userRank + 1}/${leaderboard.length} on the leaderboard!
          @channel pings: ${userStats.channelCount}
          @here pings: ${userStats.hereCount}
          Total pings: ${userStats.totalCount}
        `.trim(),
        response_type: "ephemeral",
      });
      return;
    }

    const top15 = leaderboard.slice(0, 15);
    const leaderboardText = top15
      .map(
        (row, index) =>
          `${index + 1}. <@${row.slackId}> - ${row.totalCount} pings (${row.channelCount} @channel, ${row.hereCount} @here)`,
      )
      .join("\n");

    await respond({
      text: `:tw_trophy: *Top ${top15.length} Channel Pingers*\n${leaderboardText}`,
      response_type: "ephemeral",
    });
  } catch (e) {
    console.log(e);
    logger.error(`${rayId}: Failed to fetch leaderboard: ${e}`);
    const errorMessage = generateLeaderboardErrorMessage(rayId, e);
    try {
      await respond({
        text: errorMessage,
        response_type: "ephemeral",
      });
    } catch {
      await client.chat.postMessage({
        channel: userId,
        text: errorMessage,
      });
    }
  }
}

app.shortcut(
  { callback_id: "delete_ping", type: "message_action" },
  async ({ shortcut, ack, respond, client }) => {
    await ack();
    const rayId = `delete-ping-${generateRandomString(12)}`;
    const userId = shortcut.user.id;
    logger.debug(
      `${rayId}: ${userId} invoked delete_ping on ${shortcut.message_ts}`,
    );

    const [claim] = await db
      .select()
      .from(pingsTable)
      .where(
        and(
          eq(pingsTable.ts, shortcut.message_ts),
          eq(pingsTable.slackId, userId),
        ),
      );

    if (!claim) {
      const [admin] = await db
        .select()
        .from(adminsTable)
        .where(eq(adminsTable.userId, userId));

      if (!admin) {
        await respond({
          text: ":tw_warning: *You need to be the sender of this ping to delete it.*",
          response_type: "ephemeral",
        });
        logger.debug(
          `${rayId}: Failed to delete ping: user ${userId} not sender`,
        );
        return;
      }
    }

    try {
      await Promise.all([
        db.delete(pingsTable).where(eq(pingsTable.ts, shortcut.message_ts)),
        client.chat.delete({
          channel: shortcut.channel.id,
          ts: shortcut.message_ts,
        }),
        logsnag
          .track({
            channel: "pings",
            event: "Deleted ping",
            user_id: shortcut.user.name,
            icon: "🔕",
            tags: {
              type: claim.type,
              channel: shortcut.channel.id,
              ts: claim.ts,
              user: userId,
            },
          })
          .catch(() => {}),
      ]);
    } catch (e) {
      logger.error(`${rayId}: Failed to delete ping: ${e}`);
      const errorMessage = generateDeletePingErrorMessage(rayId, e);
      try {
        await respond({
          text: errorMessage,
          response_type: "ephemeral",
        });
      } catch {
        await client.chat.postMessage({
          channel: userId,
          text: errorMessage,
        });
      }
    }
  },
);
app.shortcut(
  { callback_id: "edit_ping", type: "message_action" },
  async ({ shortcut, ack, respond, client }) => {
    await ack();
    const rayId = `edit-ping-${generateRandomString(12)}`;
    const userId = shortcut.user.id;
    logger.debug(
      `${rayId}: ${userId} invoked edit_ping on ${shortcut.message_ts}`,
    );

    const [claim] = await db
      .select()
      .from(pingsTable)
      .where(
        and(
          eq(pingsTable.ts, shortcut.message_ts),
          eq(pingsTable.slackId, userId),
        ),
      );

    if (!claim) {
      const [admin] = await db
        .select()
        .from(adminsTable)
        .where(eq(adminsTable.userId, userId));

      if (!admin) {
        await respond({
          text: ":tw_warning: *You need to be the sender of this ping to edit it.*",
          response_type: "ephemeral",
        });
        logger.debug(
          `${rayId}: Failed to edit ping: user ${userId} not sender`,
        );
        return;
      }
    }

    const modal = buildEditPingModal(
      shortcut.channel.id,
      userId,
      rayId,
      claim.ts,
      claim.type,
    );
    await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: modal,
    });
  },
);

app.view(
  "edit_ping_modal_submit",
  async ({ ack, respond, client, view, body }) => {
    await ack();
    const { channelId, ts, type, rayId } = JSON.parse(view.private_metadata);
    const message = richTextBlockToMrkdwn(
      // biome-ignore lint/style/noNonNullAssertion: Will always be there - it's a required field
      view.state.values.message.message_input.rich_text_value!,
    )
      .replaceAll("<!channel>", "@channel")
      .replaceAll("<!here>", "@here");
    let finalMessage: string;
    if (message.includes(`@${type}`)) {
      finalMessage = message;
    } else {
      finalMessage = `@${type} ${message}`;
    }

    try {
      await Promise.all([
        client.chat.update({
          channel: channelId,
          ts,
          text: finalMessage,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: finalMessage,
              },
            },
          ],
        }),
        logsnag
          .track({
            channel: "pings",
            event: "Edited ping",
            user_id: body.user.name,
            icon: "🔔",
            tags: {
              type,
              channel: channelId,
              ts,
              user: body.user.id,
            },
          })
          .catch(() => {}),
      ]);
    } catch (e) {
      logger.error(`${rayId}: Failed to edit ping: ${e}`);
      const errorMessage = generatePingErrorMessage(
        rayId,
        type,
        message,
        body.user.id,
        botId as string,
        e,
      );
      try {
        await respond({
          text: errorMessage,
          response_type: "ephemeral",
        });
      } catch {
        await client.chat.postMessage({
          channel: body.user.id,
          text: errorMessage,
        });
      }
    }
  },
);

app.command(CHANNEL_COMMAND_NAME, pingCommand.bind(null, "channel"));
app.command(HERE_COMMAND_NAME, pingCommand.bind(null, "here"));
app.command(ADD_CHANNEL_PERMS_NAME, addChannelPermsCommand.bind(null));
app.command(REMOVE_CHANNEL_PERMS_NAME, removeChannelPermsCommand.bind(null));
app.command(LIST_CHANNEL_PERMS_HAVERS_NAME, listChannelPingersCommand);
app.command(AT_CHANNEL_LEADERBOARD_NAME, leaderboardCommand);

await app.start();

logger.info("Started @channel!");
