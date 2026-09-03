import type Slack from "@slack/bolt";

// Slack now strips <!channel>/<!here> from anything an app sends through
// chat.postMessage: they get downgraded to plain "@channel" text and notify
// nobody. chat.update does not apply that filter to `blocks`, but rejects the
// token in the top-level `text` fallback with `cant_update_message`.
//
// So a ping is posted with the plain "@channel" spelling, then immediately
// updated so the block carries the real <!channel> token while `text` keeps
// the plain spelling. Edits go through the same update payload.

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
    // Sent with chat.postMessage; the token would be stripped anyway.
    initial: { text: body, blocks: [section(body)] },
    // Sent with chat.update; `text` must stay plain, the block gets the token.
    final: { text: body, blocks: [section(withToken)] },
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
