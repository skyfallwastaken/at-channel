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

export function buildPingMessage(
  type: "channel" | "here",
  message: string,
  extraBlocks: Block[] = [],
) {
  const token = `<!${type}>`;
  const plain = `@${type}`;
  const withPlain = message.replaceAll(token, plain);
  const body = withPlain.includes(plain) ? withPlain : `${plain} ${withPlain}`;
  const withToken = body.replaceAll(plain, token);

  return {
    // chat.postMessage: mention inside an attachment so it notifies.
    initial: {
      text: body,
      blocks: extraBlocks,
      attachments: [{ fallback: withToken, blocks: [section(withToken)] }],
    },
    // chat.update: clean layout, token in the block, plain `text`, no attachment.
    final: {
      text: body,
      blocks: [section(withToken), ...extraBlocks],
      attachments: [],
    },
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
    extraBlocks?: Block[];
  } = {},
) {
  const { extraBlocks = [], ...rest } = extra;
  const { initial, final } = buildPingMessage(type, message, extraBlocks);
  const posted = await client.chat.postMessage({ channel, ...rest, ...initial });
  if (!posted.ts) throw new Error("Failed to send ping");
  await client.chat.update({ channel, ts: posted.ts, ...final });
  return posted.ts;
}

type SlackFile = {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  permalink?: string;
};

// Files attached to a message the user wrote in the composer. Images become
// image blocks that reference the file already shared in the channel; anything
// else is linked in a context block.
export function blocksFromFiles(files: SlackFile[]): Block[] {
  const blocks: Block[] = [];
  const others: string[] = [];
  for (const file of files) {
    if (!file.id) continue;
    const name = file.title || file.name || "file";
    if (file.mimetype?.startsWith("image/")) {
      blocks.push({
        type: "image",
        slack_file: { id: file.id },
        alt_text: name,
      });
    } else if (file.permalink) {
      others.push(`<${file.permalink}|${name}>`);
    }
  }
  if (others.length) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `:paperclip: ${others.join(", ")}` }],
    });
  }
  return blocks;
}

export function nonBodyBlocks(
  blocks: { type?: string }[] | undefined,
): Block[] {
  return (blocks ?? []).filter((b) => b.type !== "section") as Block[];
}
