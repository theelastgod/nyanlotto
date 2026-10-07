import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PLTR_MINT,
  RESERVE_LAMPORTS,
  WINDOW_MS,
  applyBuy,
  classifyBuyer,
  emptyState,
  formatSol,
  shouldPay,
  swapBudget,
} from "../src/lottery.js";

test("the clock is 60 seconds and the prize mint is Palantir xStock", () => {
  assert.equal(WINDOW_MS, 60_000);
  assert.equal(PLTR_MINT, "XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4");
});

test("a buy spends SOL or PLTR and receives NYAN", () => {
  const base = { onCurve: true, isTreasury: false };
  assert.equal(classifyBuyer({ ...base, nyanDelta: 10n, solDelta: -1_000_000n, pltrDelta: 0n }), true);
  assert.equal(classifyBuyer({ ...base, nyanDelta: 10n, solDelta: -100n, pltrDelta: -5n }), true);
  assert.equal(classifyBuyer({ ...base, nyanDelta: 10n, solDelta: -100n, pltrDelta: 0n }), false);
  assert.equal(classifyBuyer({ ...base, nyanDelta: -10n, solDelta: 5_000_000n, pltrDelta: 0n }), false);
  assert.equal(classifyBuyer({ ...base, onCurve: false, nyanDelta: 10n, solDelta: -1_000_000n, pltrDelta: 0n }), false);
  assert.equal(classifyBuyer({ ...base, isTreasury: true, nyanDelta: 10n, solDelta: -1_000_000n, pltrDelta: 0n }), false);
});

test("a newer buy takes the clock and an older one does not", () => {
  const first = applyBuy(emptyState(), { owner: "A", sig: "s1", at: 1_000 });
  assert.equal(first.lastBuyer, "A");
  assert.equal(first.deadline, 61_000);
  const second = applyBuy(first, { owner: "B", sig: "s2", at: 5_000 });
  assert.equal(second.lastBuyer, "B");
  assert.equal(second.deadline, 65_000);
  assert.equal(applyBuy(second, { owner: "C", sig: "old", at: 4_000 }), null);
  assert.equal(applyBuy(second, { owner: "B", sig: "s2", at: 5_000 }), null);
});

test("the prize pays at the deadline and only once", () => {
  const state = applyBuy(emptyState(), { owner: "A", sig: "s1", at: 1_000 });
  assert.equal(shouldPay(emptyState(), 99_000), false);
  assert.equal(shouldPay(state, 60_999), false);
  assert.equal(shouldPay(state, 61_000), true);
  assert.equal(shouldPay({ ...state, paidSig: "s1" }, 99_000), false);
});

test("the swap cannot spend the 0.05 SOL reserve", () => {
  const balance = 1_000_000_000n;
  for (const needsAta of [false, true]) {
    const pay = swapBudget(balance, { needsAta });
    assert.ok(pay > 0n);
    assert.ok(balance - pay >= RESERVE_LAMPORTS);
  }
  assert.equal(swapBudget(RESERVE_LAMPORTS, { needsAta: false }), 0n);
  assert.equal(swapBudget(RESERVE_LAMPORTS + 5_000_000n, { needsAta: true }), 0n);
});

test("SOL text keeps the reserve readable", () => {
  assert.equal(formatSol(RESERVE_LAMPORTS), "0.05");
  assert.equal(formatSol(1_000_000_000n), "1.0");
});
