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
import { buildPingMessage, postPing, richTextWithBroadcast } from "./ping";
import { db, adminsTable, pingsTable, pingPermsTable } from "./db";
import { and, eq, sql } from "drizzle-orm";
import { LogSnag } from "@logsnag/node";
import type Slack from "@slack/bolt";
import { stripIndents } from "common-tags";
import {
  authUrl,
  deleteAsUser,
  forgetToken,
  rememberPending,
  startOAuthServer,
} from "./oauth";

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
  richText?: Slack.types.RichTextBlock,
  filePermalinks: string[] = [],
) {
  const user = await client.users.info({ user: userId });
  const displayName =
    user?.user?.profile?.display_name || user?.user?.name || "<unknown>";
  const avatar =
    user?.user?.profile?.image_original || user?.user?.profile?.image_512;

  const ts = await postPing(client, channelId, type, message, {
    username: displayName,
    icon_url: avatar,
    metadata: {
      event_type: "at_channel_message",
      event_payload: { source_user_id: userId },
    },
    richText,
    filePermalinks,
  });

  await Promise.all([
    db.insert(pingsTable).values({
      slackId: userId,
      ts,
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
          ts,
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
    await respond({
      text: `:bulb: *hint:* you can now mention <@${botId}> in a normal message to send pings with images and links.`,
      response_type: "ephemeral",
    }).catch(() => {});
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
          If this is a private channel, you'll need to add <@${botId}> to the channel. If you didn't make the private channel, get the channel **creator** to run \`/add-channel-perms <@you>\`.
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
    const richText = richTextWithBroadcast(
      // biome-ignore lint/style/noNonNullAssertion: Will always be there - it's a required field
      view.state.values.message.message_input.rich_text_value!,
      botId as string,
      type,
    );
    const message = richTextBlockToMrkdwn(richText)
      .replaceAll("<!channel>", "@channel")
      .replaceAll("<!here>", "@here");
    try {
      await Promise.all([
        client.chat.update({
          channel: channelId,
          ts,
          ...buildPingMessage(type, message, richText).final,
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

const NO_PERMS_MESSAGE = stripIndents`
  :tw_warning: *You need to be a channel manager to ping.*
  _If this is incorrect, please DM <@U059VC0UDEU>._
`.trim();

const PING_PLACEHOLDER = "<!ping>";

async function loadMentionPing(
  client: Slack.webApi.WebClient,
  channelId: string,
  ts: string,
) {
  const history = await client.conversations.history({
    channel: channelId,
    latest: ts,
    oldest: ts,
    inclusive: true,
    limit: 1,
  });
  const original = history.messages?.[0];
  if (!original || original.ts !== ts) return null;

  const richText = original.blocks?.find((b) => b.type === "rich_text") as
    | Slack.types.RichTextBlock
    | undefined;
  const message = (
    richText ? richTextBlockToMrkdwn(richText) : (original.text ?? "")
  )
    // Keep the ping where the user put the mention; the type is filled in later.
    .replaceAll(`<@${botId}>`, PING_PLACEHOLDER)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  const type: "channel" | "here" = /<!here>|@here/.test(message)
    ? "here"
    : "channel";
  const filePermalinks = (original.files ?? [])
    .map((f) => f.permalink)
    .filter((p): p is string => Boolean(p));
  return { message, type, filePermalinks, richText };
}

async function sendMentionPing(
  client: Slack.webApi.WebClient,
  userId: string,
  channelId: string,
  ts: string,
  ping: NonNullable<Awaited<ReturnType<typeof loadMentionPing>>>,
) {
  const message = ping.message.replaceAll(PING_PLACEHOLDER, `@${ping.type}`);
  const richText = ping.richText
    ? richTextWithBroadcast(ping.richText, botId as string, ping.type)
    : undefined;
  await sendPing(
    ping.type,
    message,
    userId,
    channelId,
    client,
    richText,
    ping.filePermalinks,
  );

  const outcome = await deleteAsUser(userId, channelId, ts);
  if (outcome === "deleted") return;

  await client.reactions
    .add({ channel: channelId, timestamp: ts, name: "bell" })
    .catch(() => {});

  if (outcome === "no_token") {
    await rememberPending(userId, channelId, ts);
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: ":tw_white_check_mark: Ping sent! Authorise at-channel once and it will delete your original messages for you from now on.",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: ":tw_white_check_mark: *Ping sent!* Authorise at-channel once and it will delete your original messages for you from now on (this one included).",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              style: "primary",
              text: { type: "plain_text", text: "Authorise auto-delete" },
              url: authUrl(userId),
              action_id: "authorise_auto_delete",
            },
          ],
        },
      ],
    });
  } else {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: ":tw_white_check_mark: Ping sent! I couldn't delete your original message, so you may want to remove it yourself.",
    });
  }
}

app.event("app_mention", async ({ event, client }) => {
  const rayId = `mention-${generateRandomString(12)}`;
  const { channel: channelId, user: userId, ts } = event;
  if (!userId) return;
  const ephemeral = (text: string) =>
    client.chat
      .postEphemeral({ channel: channelId, user: userId, text })
      .catch(() => {});

  try {
    if (event.thread_ts) {
      await ephemeral(
        ":tw_warning: Pings can't be sent from inside a thread. Mention me in a top-level message instead.",
      );
      return;
    }

    if (channelId === "C09BQEC01FZ") {
      await client.chat.postMessage({
        channel: channelId,
        text: `<@${userId}> tried to ping. i'm tired boss. no pings for you.`,
      });
      return;
    }

    if (!(await hasPerms(userId, channelId, client))) {
      await ephemeral(NO_PERMS_MESSAGE);
      logger.debug(`${rayId}: ${userId} mentioned the bot without perms`);
      return;
    }

    const ping = await loadMentionPing(client, channelId, ts);
    if (!ping) return;
    if (!ping.message && ping.filePermalinks.length === 0) {
      await ephemeral(":tw_warning: Add some text or an image to your ping.");
      return;
    }

    const value = (type: "channel" | "here") =>
      JSON.stringify({ channelId, ts, userId, type });
    const button = (type: "channel" | "here") => ({
      type: "button" as const,
      text: { type: "plain_text" as const, text: `Send @${type}` },
      action_id: `send_mention_ping_${type}`,
      value: value(type),
      ...(type === ping.type ? { style: "primary" as const } : {}),
    });
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: "Send this message as a ping?",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: ":tw_bell: Send this message as a ping? Pick *@channel* (everyone) or *@here* (only people online)!",
          },
        },
        {
          type: "actions",
          elements: [
            button("channel"),
            button("here"),
            {
              type: "button",
              text: { type: "plain_text", text: "Cancel" },
              action_id: "cancel_mention_ping",
              value: value(ping.type),
            },
          ],
        },
      ],
    });
  } catch (e) {
    console.log(e);
    logger.error(`${rayId}: Failed to handle mention: ${e}`);
    await ephemeral(
      generatePingErrorMessage(rayId, "channel", "", userId, botId as string, e),
    );
  }
});

app.action(/^send_mention_ping_(channel|here)$/, async ({ ack, body, action, respond, client }) => {
  await ack();
  const rayId = `mention-confirm-${generateRandomString(12)}`;
  const { channelId, ts, userId, type } = JSON.parse(
    (action as { value: string }).value,
  ) as { channelId: string; ts: string; userId: string; type: "channel" | "here" };
  if (body.user.id !== userId) return;

  try {
    if (!(await hasPerms(userId, channelId, client))) {
      await respond({ text: NO_PERMS_MESSAGE, replace_original: true });
      return;
    }
    const ping = await loadMentionPing(client, channelId, ts);
    if (!ping) {
      await respond({
        text: ":tw_warning: I can't find your original message any more, so nothing was sent.",
        replace_original: true,
      });
      return;
    }
    await respond({ delete_original: true });
    await sendMentionPing(client, userId, channelId, ts, { ...ping, type });
  } catch (e) {
    console.log(e);
    logger.error(`${rayId}: Failed to send confirmed mention ping: ${e}`);
    await respond({
      text: generatePingErrorMessage(rayId, "channel", "", userId, botId as string, e),
      replace_original: true,
    });
  }
});

app.action("cancel_mention_ping", async ({ ack, respond }) => {
  await ack();
  await respond({ delete_original: true });
});

app.action("authorise_auto_delete", async ({ ack }) => {
  await ack();
});

// Drop stored user tokens Slack tells us are gone.
app.event("tokens_revoked", async ({ event }) => {
  for (const userId of event.tokens.oauth ?? []) {
    await forgetToken(userId);
    logger.info(`${userId} revoked auto-delete`);
  }
});

app.command(CHANNEL_COMMAND_NAME, pingCommand.bind(null, "channel"));
app.command(HERE_COMMAND_NAME, pingCommand.bind(null, "here"));
app.command(ADD_CHANNEL_PERMS_NAME, addChannelPermsCommand.bind(null));
app.command(REMOVE_CHANNEL_PERMS_NAME, removeChannelPermsCommand.bind(null));
app.command(LIST_CHANNEL_PERMS_HAVERS_NAME, listChannelPingersCommand);
app.command(AT_CHANNEL_LEADERBOARD_NAME, leaderboardCommand);

await app.start();
startOAuthServer();

logger.info("Started @channel!");
