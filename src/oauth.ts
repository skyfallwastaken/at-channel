import { WebClient } from "@slack/web-api";
import { eq } from "drizzle-orm";
import { db, userTokensTable } from "./db";
import { env } from "./env";
import { logger } from "./util";
import { PENDING_TTL_MS, signState, verifyState } from "./oauthState";


export function authUrl(userId: string) {
  return `${env.PUBLIC_URL}/auth?user=${encodeURIComponent(userId)}`;
}

export async function rememberPending(userId: string, channelId: string, ts: string) {
  await db
    .insert(userTokensTable)
    .values({ slackId: userId, pendingChannelId: channelId, pendingTs: ts, pendingAt: Date.now() })
    .onConflictDoUpdate({
      target: userTokensTable.slackId,
      set: { pendingChannelId: channelId, pendingTs: ts, pendingAt: Date.now() },
    });
}

export async function forgetToken(userId: string) {
  await db.delete(userTokensTable).where(eq(userTokensTable.slackId, userId));
}

export async function deleteAsUser(
  userId: string,
  channelId: string,
  ts: string,
): Promise<"deleted" | "no_token" | "failed"> {
  const [row] = await db
    .select()
    .from(userTokensTable)
    .where(eq(userTokensTable.slackId, userId));
  if (!row?.token) return "no_token";

  try {
    await new WebClient(row.token).chat.delete({ channel: channelId, ts });
    return "deleted";
  } catch (e: unknown) {
    const code = (e as { data?: { error?: string } })?.data?.error;
    if (code === "invalid_auth" || code === "token_revoked" || code === "account_inactive") {
      await forgetToken(userId);
      return "no_token";
    }
    logger.error(`Failed to delete ${channelId}/${ts} as ${userId}: ${e}`);
    return "failed";
  }
}

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset=utf-8><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h1>${title}</h1><p>${body}</p>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

export function startOAuthServer() {
  const clientId = env.SLACK_CLIENT_ID;
  const clientSecret = env.SLACK_CLIENT_SECRET;
  const stateSecret = env.OAUTH_STATE_SECRET;
  const redirectUri = `${env.PUBLIC_URL}/oauth/callback`;

  const server = Bun.serve({
    port: env.PORT,
    routes: {
      "/auth": async (req) => {
        const userId = new URL(req.url).searchParams.get("user");
        if (!userId || !/^[UW][A-Z0-9]+$/.test(userId)) {
          return page("Bad request", "Missing or invalid user id.", 400);
        }
        const url = new URL("https://slack.com/oauth/v2/authorize");
        url.searchParams.set("client_id", clientId);
        url.searchParams.set("user_scope", "chat:write");
        url.searchParams.set("redirect_uri", redirectUri);
        url.searchParams.set("state", await signState(userId, stateSecret));
        return Response.redirect(url.toString(), 302);
      },
      "/oauth/callback": async (req) => {
        const params = new URL(req.url).searchParams;
        const code = params.get("code");
        const state = params.get("state");
        if (params.get("error")) {
          return page("Not authorised", "You cancelled the authorisation. Your originals won't be deleted automatically.");
        }
        const userId = state ? await verifyState(state, stateSecret) : null;
        if (!code || !userId) {
          return page("Invalid link", "This link is expired or invalid. Ping again and use the new button.", 400);
        }

        const result = await new WebClient().oauth.v2.access({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        });
        const token = result.authed_user?.access_token;
        if (!token || result.authed_user?.id !== userId) {
          return page("Something went wrong", "Slack returned a token for a different user. Try again.", 400);
        }

        const [row] = await db
          .select()
          .from(userTokensTable)
          .where(eq(userTokensTable.slackId, userId));
        await db
          .insert(userTokensTable)
          .values({ slackId: userId, token })
          .onConflictDoUpdate({
            target: userTokensTable.slackId,
            set: { token, pendingChannelId: null, pendingTs: null, pendingAt: null },
          });

        const pendingFresh =
          row?.pendingChannelId && row.pendingTs && row.pendingAt && Date.now() - row.pendingAt < PENDING_TTL_MS;
        if (pendingFresh) {
          await deleteAsUser(userId, row.pendingChannelId as string, row.pendingTs as string);
        }
        logger.info(`${userId} authorised auto-delete`);
        return page("All set!", "at-channel will now delete your original message whenever it reposts a ping. You can close this tab.");
      },
    },
    fetch: () => page("Not found", "Nothing here.", 404),
  });
  logger.info(`OAuth server listening on ${server.url}`);
  return server;
}
