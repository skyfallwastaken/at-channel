import { test, expect } from "bun:test";
import { buildPingMessage } from "./ping";

test("prepends the mention when missing; only the final block carries the token", () => {
  const { initial, final } = buildPingMessage("channel", "hello world");
  expect(initial).toEqual({ text: "@channel hello world", blocks: [{ type: "section", text: { type: "mrkdwn", text: "@channel hello world" } }] });
  expect(final.text).toBe("@channel hello world");
  expect(final.blocks[0].text.text).toBe("<!channel> hello world");
});

test("keeps an inline mention in place, in either spelling", () => {
  expect(buildPingMessage("here", "hey @here folks").final.blocks[0].text.text).toBe("hey <!here> folks");
  expect(buildPingMessage("here", "hey <!here> folks").final.blocks[0].text.text).toBe("hey <!here> folks");
});

test("the text fallback never contains the token", () => {
  const { initial, final } = buildPingMessage("channel", "<!channel> x");
  expect(initial.text).not.toContain("<!");
  expect(final.text).not.toContain("<!");
});
