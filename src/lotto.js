import {
  buildSwap,
  buildTransfer,
  fetchRecentBuys,
  quotePltr,
  rpcUrl,
  safeError,
  sendSigned,
  signatureStatus,
  treasuryAddress,
  treasurySnapshot,
} from "./chain.js";
import {
  PLTR_DECIMALS,
  PLTR_MINT,
  PLTR_SYMBOL,
  WINDOW_MS,
  applyBuy,
  emptyState,
  formatSol,
  formatTokens,
  shouldPay,
} from "./lottery.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export class Lotto {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/history")) return json(await this.history());
    if (url.pathname.endsWith("/tick")) {
      await this.tick();
      return json({ ok: true });
    }
    this.ctx.waitUntil(this.ensure());
    return json(await this.view());
  }

  async alarm() {
    await this.tick();
  }

  async ensure() {
    try {
      const existing = await this.ctx.storage.getAlarm();
      if (!existing) await this.schedule();
    } catch {
      await this.schedule();
    }
  }

  async schedule() {
    const mint = String(this.env.NYAN_MINT || "").trim();
    const state = await this.readState();
    const now = Date.now();
    let when = now + (mint ? 5_000 : 60_000);
    if (state.deadline > now && state.deadline < when && state.paidSig !== state.lastSig) when = state.deadline;
    await this.ctx.storage.setAlarm(when);
  }

  async tick() {
    try { await this.ingest(); } catch (err) { await this.note(err); }
    try { await this.applyQueue(); } catch (err) { await this.note(err); }
    try { await this.refreshSnap(); } catch (err) { await this.note(err); }
    try { await this.maybePay(); } catch (err) { await this.note(err); }
    await this.schedule();
  }

  async readState() {
    return (await this.ctx.storage.get("state")) || emptyState();
  }

  async ingest() {
    const mint = String(this.env.NYAN_MINT || "").trim();
    if (!mint) return;
    const head = await this.ctx.storage.get("sigHead");
    const { buys, head: nextHead } = await fetchRecentBuys(rpcUrl(this.env), {
      nyanMint: mint,
      pltrMint: PLTR_MINT,
      treasury: treasuryAddress(this.env),
      until: head || undefined,
    });
    if (nextHead) await this.ctx.storage.put("sigHead", nextHead);
    const queue = (await this.ctx.storage.get("queue")) || [];
    for (const buy of buys) {
      if (!queue.some((row) => row.sig === buy.sig)) queue.push(buy);
    }
    await this.ctx.storage.put("queue", queue.slice(-40));
  }

  async applyQueue() {
    if (await this.ctx.storage.get("job")) return;
    const queue = (await this.ctx.storage.get("queue")) || [];
    let state = await this.readState();
    for (const buy of [...queue].sort((a, b) => a.at - b.at)) {
      const next = applyBuy(state, buy);
      if (next) state = next;
    }
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.put("queue", []);
  }

  async refreshSnap() {
    const treasury = treasuryAddress(this.env);
    if (!treasury) return;
    const now = Date.now();
    const prev = (await this.ctx.storage.get("snap")) || {};
    const live = await treasurySnapshot(rpcUrl(this.env), treasury);
    const snap = { ...live, sol: live.sol.toString(), pltr: live.pltr.toString(), spendable: live.spendable.toString(), at: now };
    if (live.spendable > 0n && (!prev.quoteAt || now - prev.quoteAt > 20_000)) {
      const quoted = await quotePltr(live.spendable);
      snap.quoteOut = quoted ? quoted.out.toString() : null;
      snap.quoteAt = now;
    } else {
      snap.quoteOut = prev.quoteOut ?? null;
      snap.quoteAt = prev.quoteAt ?? 0;
    }
    await this.ctx.storage.put("snap", snap);
  }

  async maybePay() {
    const now = Date.now();
    const backoff = (await this.ctx.storage.get("payBackoff")) || 0;
    if (backoff > now) return;
    const job = await this.ctx.storage.get("job");
    if (job) {
      await this.chase(job, now);
      return;
    }
    const state = await this.readState();
    if (!shouldPay(state, now)) return;
    if (!this.env.TREASURY_SECRET) {
      await this.note("treasury signing key is not set");
      return;
    }
    const snap = await treasurySnapshot(rpcUrl(this.env), treasuryAddress(this.env));
    const skip = await this.ctx.storage.get("pltrSkip");
    if (snap.pltr > 0n && skip !== state.lastSig) {
      await this.startJob("pltr", () => buildTransfer(this.env, state.lastBuyer), state, now);
      return;
    }
    if (snap.spendable > 0n) {
      await this.startJob("swap", () => buildSwap(this.env, state.lastBuyer), state, now);
      return;
    }
    await this.finish({ buyer: state.lastBuyer, buySig: state.lastSig, sig: null, out: "0" }, { empty: true });
  }

  async startJob(step, build, state, now) {
    let built;
    try {
      built = await build();
    } catch (err) {
      if (step === "pltr") {
        await this.ctx.storage.put("pltrSkip", state.lastSig);
        await this.note(err);
        return;
      }
      throw err;
    }
    if (built.empty) {
      if (step === "pltr") {
        await this.ctx.storage.put("pltrSkip", state.lastSig);
        return;
      }
      await this.finish({ buyer: state.lastBuyer, buySig: state.lastSig, sig: null, out: "0" }, { empty: true });
      return;
    }
    const job = {
      step,
      sig: built.sig,
      raw: built.raw,
      out: built.out,
      at: now,
      buyer: state.lastBuyer,
      buySig: state.lastSig,
    };
    await this.ctx.storage.put("job", job);
    try {
      await sendSigned(this.env, job.raw);
    } catch (err) {
      await this.note(err);
    }
  }

  async chase(job, now) {
    const status = await signatureStatus(this.env, job.sig);
    if (status === "done") {
      if (job.step === "pltr") {
        await this.ctx.storage.put("pltrSkip", job.buySig);
        await this.ctx.storage.delete("job");
        const rounds = (await this.ctx.storage.get("rounds")) || [];
        rounds.unshift({ buyer: job.buyer, buySig: job.buySig, paidAt: now, kind: "pltr", sig: job.sig, pltrOut: job.out, empty: false });
        await this.ctx.storage.put("rounds", rounds.slice(0, 40));
        return;
      }
      await this.finish(job, { empty: false });
      return;
    }
    if (status === "err" || (status === "unknown" && now - job.at > 90_000)) {
      await this.ctx.storage.delete("job");
      await this.ctx.storage.put("payBackoff", now + 30_000);
      if (job.step === "pltr") await this.ctx.storage.put("pltrSkip", job.buySig);
      await this.note(status === "err" ? `${job.step} transaction failed` : `${job.step} transaction expired`);
      return;
    }
    try {
      await sendSigned(this.env, job.raw);
    } catch (err) {
      await this.note(err);
    }
  }

  async finish(job, extra) {
    const state = await this.readState();
    state.paidSig = job.buySig;
    await this.ctx.storage.put("state", state);
    const rounds = (await this.ctx.storage.get("rounds")) || [];
    rounds.unshift({
      buyer: job.buyer,
      buySig: job.buySig,
      paidAt: Date.now(),
      kind: extra.empty ? "empty" : "swap",
      sig: job.sig,
      pltrOut: job.out || "0",
      empty: Boolean(extra.empty),
    });
    await this.ctx.storage.put("rounds", rounds.slice(0, 40));
    await this.ctx.storage.delete("job");
    await this.ctx.storage.delete("pltrSkip");
    await this.ctx.storage.delete("payBackoff");
  }

  async history() {
    return { rounds: (await this.ctx.storage.get("rounds")) || [] };
  }

  async view() {
    const now = Date.now();
    const state = await this.readState();
    const snap = (await this.ctx.storage.get("snap")) || {};
    const rounds = (await this.ctx.storage.get("rounds")) || [];
    const job = await this.ctx.storage.get("job");
    const mint = String(this.env.NYAN_MINT || "").trim() || null;
    const treasury = treasuryAddress(this.env);
    const armed = Boolean(mint && treasury && this.env.TREASURY_SECRET);
    let phase = armed ? "waiting" : (mint || treasury ? "setup" : "unarmed");
    if (state.lastBuyer && state.paidSig !== state.lastSig) {
      phase = job || now >= state.deadline ? "paying" : "countdown";
    }
    const pltrRaw = snap.pltr || "0";
    const quoteRaw = snap.quoteOut || "0";
    return {
      name: "NYANLOTTO",
      symbol: "NYAN",
      pair: "NYAN/PLTR",
      prize: "PLTR",
      prizeSymbol: PLTR_SYMBOL,
      prizeMint: PLTR_MINT,
      windowMs: WINDOW_MS,
      reserveSol: "0.05",
      phase,
      now,
      deadline: state.deadline || null,
      lastBuyer: state.lastBuyer,
      lastBuyAt: state.lastBuyAt || null,
      mint,
      treasury,
      payoutsArmed: armed,
      treasurySol: snap.sol ? formatSol(snap.sol) : null,
      feePotSol: snap.spendable ? formatSol(snap.spendable) : null,
      pltrOnHand: formatTokens(pltrRaw, PLTR_DECIMALS),
      pltrQuote: snap.quoteOut ? formatTokens(quoteRaw, PLTR_DECIMALS) : null,
      lastError: (await this.ctx.storage.get("lastError")) || null,
      rounds: rounds.slice(0, 12).map((round) => ({
      ...round,
      pltrText: formatTokens(round.pltrOut || "0", PLTR_DECIMALS),
    })),
    };
  }

  async note(err) {
    await this.ctx.storage.put("lastError", safeError(err));
  }
}
