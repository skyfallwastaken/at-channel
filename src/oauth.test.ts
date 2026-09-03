import { test, expect } from "bun:test";
import { signState, verifyState } from "./oauthState";

const secret = "test-secret";

test("round-trips the user id", async () => {
  const state = await signState("U123ABC", secret, 1_000_000);
  expect(await verifyState(state, secret, 1_000_000 + 60_000)).toBe("U123ABC");
});

test("rejects a tampered or foreign-signed state", async () => {
  const state = await signState("U123ABC", secret);
  expect(await verifyState(state, "other-secret")).toBeNull();
  const [payload] = state.split(".");
  expect(await verifyState(`${payload}.forged`, secret)).toBeNull();
  expect(await verifyState("garbage", secret)).toBeNull();
});

test("expires after ten minutes", async () => {
  const state = await signState("U123ABC", secret, 0);
  expect(await verifyState(state, secret, 11 * 60 * 1000)).toBeNull();
});
