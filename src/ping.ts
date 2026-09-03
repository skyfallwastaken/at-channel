import type Slack from "@slack/bolt";

// Slack now strips <!channel>/<!here> from a bot's chat.postMessage `text`,
// `blocks`, and rich_text broadcast elements: they are downgraded to plain
// "@channel" and notify nobody. The one place the mention still fires a
// notification at post time is inside legacy `attachments`.
//
// chat.update accepts the token in `blocks` (but rejects it in `text` with
// `cant_update_message`) and never re-notifies. So a ping is posted with the
// mention in an attachment, then immediately updated to a clean block layout
// with the attachment removed. Edits reuse the same final payload.

const section = (text: string) => ({
  type: "section",
  text: { type: "mrkdwn", text },
});

export function buildPingMessage(type: "channel" | "here", message: string) {
  const token = `<!${type}>`;
  const plain = `@${type}`;
  const withPlain = message.replaceAll(token, plain);
  const body = withPlain.includes(plain) ? withPlain : `${plain} ${withPlain}`;
  const withToken = body.replaceAll(plain, token);

  return {
    // chat.postMessage: mention inside an attachment so it notifies.
    initial: {
      text: body,
      attachments: [{ fallback: withToken, blocks: [section(withToken)] }],
    },
    // chat.update: clean layout, token in the block, plain `text`, no attachment.
    final: { text: body, blocks: [section(withToken)], attachments: [] },
  };
}

export async function postPing(
  client: Slack.webApi.WebClient,
  channel: string,
  type: "channel" | "here",
  message: string,
  extra: {
    username?: string;
    icon_url?: string;
    metadata?: Slack.webApi.ChatPostMessageArguments["metadata"];
  } = {},
) {
  const { initial, final } = buildPingMessage(type, message);
  const posted = await client.chat.postMessage({ channel, ...extra, ...initial });
  if (!posted.ts) throw new Error("Failed to send ping");
  await client.chat.update({ channel, ts: posted.ts, ...final });
  return posted.ts;
}
