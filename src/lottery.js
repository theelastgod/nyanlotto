/** 60 seconds with no new buy pays the last buyer. */
export const WINDOW_MS = 60_000;

/** Lamports that must remain in the treasury. Not part of the prize. */
export const RESERVE_LAMPORTS = 50_000_000n;

/** Kept on top of the reserve so the swap fee cannot spend it. */
export const FEE_BUFFER_LAMPORTS = 3_000_000n;

/** Rent for a new PLTRx account, paid from SOL above the reserve. */
export const ATA_RENT_LAMPORTS = 2_500_000n;

/** Dust below this stays in the treasury for a later round. */
export const MIN_SWAP_LAMPORTS = 10_000_000n;

/** Palantir xStock on Solana (Token-2022, 8 decimals). The $PLTR prize. */
export const PLTR_MINT = "XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4";
export const PLTR_DECIMALS = 8;
export const PLTR_SYMBOL = "PLTRx";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

const SOL_FEE_IS_A_BUY = -20_000n;

export function classifyBuyer({ nyanDelta, solDelta, pltrDelta, onCurve, isTreasury }) {
  if (!onCurve || isTreasury) return false;
  if (nyanDelta <= 0n) return false;
  return solDelta < SOL_FEE_IS_A_BUY || pltrDelta < 0n;
}

export function emptyState() {
  return { lastBuyer: null, lastBuyAt: 0, lastSig: null, deadline: 0, paidSig: null };
}

/** Returns the next state, or null when this buy does not take the clock. */
export function applyBuy(state, buy) {
  if (!buy?.owner || !buy.sig || !buy.at) return null;
  if (state.paidSig === buy.sig || state.lastSig === buy.sig) return null;
  if (state.lastBuyAt && buy.at <= state.lastBuyAt) return null;
  return {
    lastBuyer: buy.owner,
    lastBuyAt: buy.at,
    lastSig: buy.sig,
    deadline: buy.at + WINDOW_MS,
    paidSig: state.paidSig ?? null,
  };
}

export function shouldPay(state, now) {
  if (!state?.lastBuyer || !state.lastSig) return false;
  if (state.paidSig === state.lastSig) return false;
  return now >= state.deadline;
}

export function swapBudget(balance, { needsAta = false } = {}) {
  const rent = needsAta ? ATA_RENT_LAMPORTS : 0n;
  const room = BigInt(balance) - RESERVE_LAMPORTS - FEE_BUFFER_LAMPORTS - rent;
  if (room < MIN_SWAP_LAMPORTS) return 0n;
  return room;
}

export function formatSol(lamports) {
  const n = BigInt(lamports);
  const sign = n < 0n ? "-" : "";
  const v = n < 0n ? -n : n;
  const whole = v / 1_000_000_000n;
  const frac = (v % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${sign}${whole}.${frac || "0"}`;
}

export function formatTokens(amount, decimals) {
  const n = BigInt(amount);
  const sign = n < 0n ? "-" : "";
  const v = n < 0n ? -n : n;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(Number(decimals), "0").replace(/0+$/, "");
  return `${sign}${whole}${frac ? `.${frac}` : ""}`;
}
