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
  expect(final.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: "<!channel> hello world" } }]);
  expect(final.attachments).toEqual([]);
});

test("keeps an inline mention in place, in either spelling", () => {
  expect(bodyOf(buildPingMessage("here", "hey @here folks").final)).toBe("hey <!here> folks");
  expect(bodyOf(buildPingMessage("here", "hey <!here> folks").final)).toBe("hey <!here> folks");
});

test("extra blocks ride in both payloads after the body", () => {
  const img = { type: "image" as const, slack_file: { id: "F1" }, alt_text: "pic" };
  const { initial, final } = buildPingMessage("channel", "look", [img]);
  expect(initial.blocks).toEqual([img]);
  expect(final.blocks.map((b) => b.type)).toEqual(["section", "image"]);
});

test("blocksFromFiles turns images into slack_file image blocks and links the rest", () => {
  const { blocksFromFiles } = require("./ping");
  const blocks = blocksFromFiles([
    { id: "F1", name: "a.png", mimetype: "image/png" },
    { id: "F2", title: "notes.pdf", mimetype: "application/pdf", permalink: "https://x/y" },
    { name: "no-id.png", mimetype: "image/png" },
  ]);
  expect(blocks).toEqual([
    { type: "image", slack_file: { id: "F1" }, alt_text: "a.png" },
    { type: "context", elements: [{ type: "mrkdwn", text: ":paperclip: <https://x/y|notes.pdf>" }] },
  ]);
});
