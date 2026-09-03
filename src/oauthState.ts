export const PENDING_TTL_MS = 10 * 60 * 1000;

const encoder = new TextEncoder();
async function hmac(payload: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Buffer.from(sig).toString("base64url");
}

export async function signState(userId: string, secret: string, now = Date.now()) {
  const payload = Buffer.from(`${userId}.${now}`).toString("base64url");
  return `${payload}.${await hmac(payload, secret)}`;
}

export async function verifyState(
  state: string,
  secret: string,
  now = Date.now(),
): Promise<string | null> {
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;
  if (sig !== (await hmac(payload, secret))) return null;
  const [userId, issued] = Buffer.from(payload, "base64url").toString().split(".");
  if (!userId || !issued) return null;
  if (now - Number(issued) > PENDING_TTL_MS) return null;
  return userId;
}
