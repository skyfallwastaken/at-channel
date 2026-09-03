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

type Block = Slack.types.AnyBlock;

const section = (text: string): Slack.types.SectionBlock => ({
  type: "section",
  text: { type: "mrkdwn", text },
});

type RichText = Slack.types.RichTextBlock;

// `message` is mrkdwn and is used for the notification attachment and the
// `text` fallback. When `richText` is given (a rich_text block that already
// contains a broadcast element), it is posted verbatim as the body so Slack
// keeps folded links, lists, code and other formatting exactly as typed.
export function buildPingMessage(
  type: "channel" | "here",
  message: string,
  richText?: RichText,
) {
  const token = `<!${type}>`;
  const plain = `@${type}`;
  const withPlain = message.replaceAll(token, plain);
  const body = withPlain.includes(plain) ? withPlain : `${plain} ${withPlain}`;
  const withToken = body.replaceAll(plain, token);
  const bodyBlock: Block = richText ?? section(withToken);

  return {
    // chat.postMessage: mention inside an attachment so it notifies.
    initial: {
      text: body,
      attachments: [{ fallback: withToken, blocks: [section(withToken)] }],
    },
    // chat.update: clean layout, mention in the block, plain `text`, no attachment.
    final: {
      text: body,
      blocks: [bodyBlock],
      attachments: [],
    },
  };
}

// Returns a copy of `block` where mentions of `botUserId` become a broadcast
// element for `type`. If there is no broadcast at all, one is prepended.
export function richTextWithBroadcast(
  block: RichText,
  botUserId: string,
  type: "channel" | "here",
): RichText {
  const broadcast = { type: "broadcast" as const, range: type };
  let found = false;
  const elements = block.elements.map((el) => {
    if (!("elements" in el)) return el;
    const swap = (e: Slack.types.RichTextElement) => {
      if (e.type === "user" && e.user_id === botUserId) {
        found = true;
        return broadcast;
      }
      if (e.type === "broadcast") {
        found = true;
        return { ...e, range: type };
      }
      return e;
    };
    if (el.type === "rich_text_list") {
      return {
        ...el,
        elements: el.elements.map((sec) => ({
          ...sec,
          elements: sec.elements.map(swap),
        })),
      };
    }
    return { ...el, elements: el.elements.map(swap) };
  });
  if (!found) {
    elements.unshift({
      type: "rich_text_section",
      elements: [broadcast, { type: "text", text: " " }],
    });
  }
  return { ...block, elements } as RichText;
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
    richText?: RichText;
    // Slack file permalinks (from the user's original message). Slack turns
    // permalinks in `text` into real file attachments on the message, of any
    // type, a few seconds after posting. Updating before that happens cancels
    // it, so we wait for the files to land before the clean-up update.
    filePermalinks?: string[];
  } = {},
) {
  const { richText, filePermalinks = [], ...rest } = extra;
  const { initial, final } = buildPingMessage(type, message, richText);
  const posted = await client.chat.postMessage({
    channel,
    ...rest,
    ...initial,
    text: [initial.text, ...filePermalinks].join(" "),
    unfurl_links: true,
    unfurl_media: true,
  });
  if (!posted.ts) throw new Error("Failed to send ping");
  if (filePermalinks.length) {
    await waitForFiles(client, channel, posted.ts, filePermalinks.length);
  }
  await client.chat.update({ channel, ts: posted.ts, ...final });
  return posted.ts;
}

const FILE_WAIT_MS = 15_000;
const FILE_POLL_MS = 500;

async function waitForFiles(
  client: Slack.webApi.WebClient,
  channel: string,
  ts: string,
  count: number,
) {
  const deadline = Date.now() + FILE_WAIT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(FILE_POLL_MS);
    const history = await client.conversations.history({
      channel,
      latest: ts,
      oldest: ts,
      inclusive: true,
      limit: 1,
    });
    const files = history.messages?.[0]?.files?.length ?? 0;
    if (files >= count) return;
  }
}
