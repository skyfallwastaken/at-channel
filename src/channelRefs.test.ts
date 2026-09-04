import { test, expect } from "bun:test";
import { fixChannelRefs } from "./channelRefs";

const client = {} as never;

test("leaves refs alone when the channel exists", async () => {
  const out = await fixChannelRefs("join <#C1|haven> now", client, async () => true, async () => "C2");
  expect(out).toBe("join <#C1|haven> now");
});

test("re-resolves an unknown id by name", async () => {
  const out = await fixChannelRefs("join <#CBAD|haven>", client, async (id) => id !== "CBAD", async (n) => (n === "haven" ? "CGOOD" : undefined));
  expect(out).toBe("join <#CGOOD|haven>");
});

test("falls back to plain text when the name is unknown too", async () => {
  const out = await fixChannelRefs("join <#CBAD|nope>", client, async () => false, async () => undefined);
  expect(out).toBe("join #nope");
});
