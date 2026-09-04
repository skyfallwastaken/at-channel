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
type RichText = Slack.types.RichTextBlock;

// verbatim: Slack must not re-resolve plain "#name" text by itself; it picks
// the wrong channel when names collide. Slash commands send real <#ID|name>
// references (should_escape), which render fine verbatim.
const section = (text: string): Slack.types.SectionBlock => ({
  type: "section",
  text: { type: "mrkdwn", text, verbatim: true },
});

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
    // Files from the user's original message. Their permalinks go in `text`;
    // Slack then attaches the files to the ping, of any type, asynchronously.
    files?: PingFile[];
    // Runs as soon as the ping exists, in parallel with the clean-up update.
    onPosted?: (ts: string) => Promise<unknown>;
    // Runs once the files have attached to the ping (immediately when there
    // are none). Deleting the original before then deletes its files too.
    onFilesAttached?: (ts: string, attached: boolean) => Promise<unknown>;
  } = {},
) {
  const { richText, files = [], onPosted, onFilesAttached, ...rest } = extra;
  const filePermalinks = files.map((f) => f.permalink);
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
  const ts = posted.ts;
  const side = Promise.all([
    onPosted?.(ts),
    (async () => {
      const attached = files.length
        ? await waitForFiles(client, channel, ts, files)
        : true;
      await onFilesAttached?.(ts, attached);
    })(),
  ]);
  await client.chat.update({
    channel,
    ts,
    ...final,
    text: [final.text, ...filePermalinks].join(" "),
  });
  await side;
  return ts;
}

export type PingFile = { id: string; permalink: string };

const FILE_WAIT_MS = 15_000;

type Waiter = { remaining: Set<string>; resolve: () => void };
const waiters = new Map<string, Set<Waiter>>(); // channel -> waiters

export function notifyFileShared(channel: string, fileId: string) {
  for (const w of waiters.get(channel) ?? []) {
    if (w.remaining.delete(fileId) && w.remaining.size === 0) w.resolve();
  }
}

async function waitForFiles(
  client: Slack.webApi.WebClient,
  channel: string,
  ts: string,
  files: PingFile[],
) {
  const set = waiters.get(channel) ?? new Set<Waiter>();
  waiters.set(channel, set);
  let done = false;
  await new Promise<void>((resolve) => {
    const waiter: Waiter = {
      remaining: new Set(files.map((f) => f.id)),
      resolve: () => {
        done = true;
        set.delete(waiter);
        resolve();
      },
    };
    set.add(waiter);
    setTimeout(() => {
      set.delete(waiter);
      resolve();
    }, FILE_WAIT_MS);
  });
  if (set.size === 0) waiters.delete(channel);
  if (done) return true;
  // No event in time; check once in case it was missed.
  const history = await client.conversations.history({
    channel,
    latest: ts,
    oldest: ts,
    inclusive: true,
    limit: 1,
  });
  return (history.messages?.[0]?.files?.length ?? 0) >= files.length;
}
