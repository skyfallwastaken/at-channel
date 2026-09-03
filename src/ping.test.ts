import { test, expect } from "bun:test";
import { buildPingMessage } from "./ping";

test("initial post carries the mention only inside an attachment", () => {
  const { initial } = buildPingMessage("channel", "hello world");
  expect(initial.text).toBe("@channel hello world");
  expect(initial.attachments[0].blocks[0].text.text).toBe("<!channel> hello world");
  expect(JSON.stringify(initial).indexOf("<!")).toBe(JSON.stringify(initial).indexOf("<!channel>"));
});

test("final update has the token in a block, plain text, and clears the attachment", () => {
  const { final } = buildPingMessage("channel", "hello world");
  expect(final.text).toBe("@channel hello world");
  expect(final.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: "<!channel> hello world" } }]);
  expect(final.attachments).toEqual([]);
});

test("keeps an inline mention in place, in either spelling", () => {
  expect(buildPingMessage("here", "hey @here folks").final.blocks[0].text.text).toBe("hey <!here> folks");
  expect(buildPingMessage("here", "hey <!here> folks").final.blocks[0].text.text).toBe("hey <!here> folks");
});
