import { test, expect } from "bun:test";
import { buildPingMessage } from "./ping";

const bodyOf = (p: { blocks: unknown[] }) =>
  (p.blocks[0] as { text: { text: string } }).text.text;

test("initial post carries the mention only inside an attachment", () => {
  const { initial } = buildPingMessage("channel", "hello world");
  expect(initial.text).toBe("@channel hello world");
  expect(initial.attachments[0]?.blocks[0]?.text?.text).toBe("<!channel> hello world");
  expect(JSON.stringify(initial).indexOf("<!")).toBe(JSON.stringify(initial).indexOf("<!channel>"));
});

test("final update has the token in a block, plain text, and clears the attachment", () => {
  const { final } = buildPingMessage("channel", "hello world");
  expect(final.text).toBe("@channel hello world");
  expect(final.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: "<!channel> hello world", verbatim: true } }]);
  expect(final.attachments).toEqual([]);
});

test("keeps an inline mention in place, in either spelling", () => {
  expect(bodyOf(buildPingMessage("here", "hey @here folks").final)).toBe("hey <!here> folks");
  expect(bodyOf(buildPingMessage("here", "hey <!here> folks").final)).toBe("hey <!here> folks");
});

test("rich text body replaces the section in the final payload only", () => {
  const rt = { type: "rich_text" as const, elements: [] };
  const { initial, final } = buildPingMessage("channel", "hi @channel", rt);
  expect(final.blocks[0]).toBe(rt);
  expect(initial.attachments[0]?.blocks[0]?.text?.text).toBe("hi <!channel>");
});

test("richTextWithBroadcast swaps the bot mention in place and keeps other elements", () => {
  const { richTextWithBroadcast } = require("./ping");
  const link = { type: "link", url: "https://x.y/", text: "x.y", truncated: true };
  const block = { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "hi " }, { type: "user", user_id: "UBOT" }, { type: "text", text: " " }, link] }] };
  const out = richTextWithBroadcast(block, "UBOT", "here");
  expect(out.elements[0].elements).toEqual([{ type: "text", text: "hi " }, { type: "broadcast", range: "here" }, { type: "text", text: " " }, link]);
});

test("richTextWithBroadcast prepends a broadcast when there is none", () => {
  const { richTextWithBroadcast } = require("./ping");
  const block = { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "plain" }] }] };
  const out = richTextWithBroadcast(block, "UBOT", "channel");
  expect(out.elements[0]).toEqual({ type: "rich_text_section", elements: [{ type: "broadcast", range: "channel" }, { type: "text", text: " " }] });
  expect(out.elements[1].elements[0].text).toBe("plain");
});
