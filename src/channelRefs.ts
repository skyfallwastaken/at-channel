import type Slack from "@slack/bolt";
import { logger } from "./util";

const REF = /<#([A-Z0-9]+)\|([^>]+)>/g;
const CACHE_TTL_MS = 30 * 60 * 1000;

let cache: { at: number; byName: Map<string, string> } | null = null;
let refreshing: Promise<Map<string, string>> | null = null;

async function channelsByName(client: Slack.webApi.WebClient) {
  const fresh = cache && Date.now() - cache.at < CACHE_TTL_MS;
  if (cache && !fresh) void refreshChannels(client);
  return cache ? cache.byName : refreshChannels(client);
}

export function warmChannelCache(client: Slack.webApi.WebClient) {
  refreshChannels(client).catch((e) =>
    logger.error(`Failed to warm channel cache: ${e}`),
  );
}

function refreshChannels(client: Slack.webApi.WebClient) {
  if (!refreshing) {
    refreshing = loadChannels(client).finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

async function loadChannels(client: Slack.webApi.WebClient) {
  const byName = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const page = await client.conversations.list({
      types: "public_channel",
      exclude_archived: true,
      limit: 1000,
      cursor,
    });
    for (const ch of page.channels ?? []) {
      if (ch.id && ch.name) byName.set(ch.name, ch.id);
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  cache = { at: Date.now(), byName };
  return byName;
}

export async function fixChannelRefs(
  text: string,
  client: Slack.webApi.WebClient,
  exists: (id: string) => Promise<boolean> = (id) =>
    client.conversations
      .info({ channel: id })
      .then(() => true)
      .catch(() => false),
  lookup: (name: string) => Promise<string | undefined> = (name) =>
    channelsByName(client).then((m) => m.get(name)),
) {
  const refs = [...text.matchAll(REF)];
  if (refs.length === 0) return text;

  const known = await Promise.all(refs.map(([, id]) => exists(id)));
  let out = text;
  for (const [i, [ref, id, name]] of refs.entries()) {
    if (known[i]) continue;
    const found = await lookup(name);
    if (found) {
      logger.warn(`Channel ref ${id} not found; using #${name} = ${found}`);
      out = out.replaceAll(ref, `<#${found}|${name}>`);
    } else {
      logger.warn(`Channel ref ${id} not found and #${name} unknown`);
      out = out.replaceAll(ref, `#${name}`);
    }
  }
  return out;
}
