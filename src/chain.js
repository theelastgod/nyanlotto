import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  ATA_RENT_LAMPORTS,
  FEE_BUFFER_LAMPORTS,
  PLTR_DECIMALS,
  PLTR_MINT,
  RESERVE_LAMPORTS,
  WSOL_MINT,
  classifyBuyer,
  swapBudget,
} from "./lottery.js";

export const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
export const JUPITER_SWAP_URL = "https://lite-api.jup.ag/swap/v1/swap";

export function rpcUrl(env) {
  if (env.HELIUS_API_KEY) return `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
  if (env.SOLANA_RPC) return env.SOLANA_RPC;
  return "https://api.mainnet-beta.solana.com";
}

export function loadKeypair(secret) {
  const trimmed = String(secret || "").trim();
  const bytes = trimmed.startsWith("[")
    ? Uint8Array.from(JSON.parse(trimmed))
    : bs58.decode(trimmed);
  return Keypair.fromSecretKey(bytes);
}

export function treasuryAddress(env) {
  const pinned = String(env.TREASURY_PUBKEY || "").trim();
  if (pinned) return pinned;
  if (!env.TREASURY_SECRET) return null;
  try {
    return loadKeypair(env.TREASURY_SECRET).publicKey.toBase58();
  } catch {
    return null;
  }
}

export function safeError(err) {
  return String(err?.message || err)
    .replace(/api-key=[^&\s]+/gi, "api-key=redacted")
    .slice(0, 240);
}

export async function rpcCall(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || "rpc error");
  return body.result;
}

function accountKeys(tx) {
  const raw = (tx.transaction?.message?.accountKeys || []).map((key) =>
    typeof key === "string" ? key : key.pubkey,
  );
  const loaded = tx.meta?.loadedAddresses;
  if (!loaded) return raw;
  return raw.concat(loaded.writable || [], loaded.readonly || []);
}

function tokenMap(rows, mint) {
  const map = new Map();
  for (const row of rows || []) {
    if (row.mint !== mint || !row.owner) continue;
    const amount = BigInt(row.uiTokenAmount?.amount || "0");
    map.set(row.owner, (map.get(row.owner) || 0n) + amount);
  }
  return map;
}

function nativeDelta(tx, owner) {
  const keys = accountKeys(tx);
  const pre = tx.meta?.preBalances || [];
  const post = tx.meta?.postBalances || [];
  if (keys.length !== pre.length || keys.length !== post.length) return 0n;
  let total = 0n;
  keys.forEach((key, index) => {
    if (key === owner) total += BigInt(post[index]) - BigInt(pre[index]);
  });
  return total;
}

function onCurve(owner) {
  try {
    return PublicKey.isOnCurve(new PublicKey(owner).toBytes());
  } catch {
    return false;
  }
}

export function parseBuyers(tx, { nyanMint, pltrMint, treasury }) {
  if (!tx?.meta || tx.meta.err) return [];
  const before = tokenMap(tx.meta.preTokenBalances, nyanMint);
  const after = tokenMap(tx.meta.postTokenBalances, nyanMint);
  const pltrBefore = tokenMap(tx.meta.preTokenBalances, pltrMint);
  const pltrAfter = tokenMap(tx.meta.postTokenBalances, pltrMint);
  const buyers = [];
  for (const [owner, end] of after) {
    const nyanDelta = end - (before.get(owner) || 0n);
    const pltrDelta = (pltrAfter.get(owner) || 0n) - (pltrBefore.get(owner) || 0n);
    const solDelta = nativeDelta(tx, owner);
    if (classifyBuyer({
      nyanDelta,
      solDelta,
      pltrDelta,
      onCurve: onCurve(owner),
      isTreasury: Boolean(treasury) && owner === treasury,
    })) {
      buyers.push({ owner, nyanDelta });
    }
  }
  return buyers;
}

function signerOf(tx) {
  for (const key of tx.transaction?.message?.accountKeys || []) {
    if (typeof key === "object" && key.signer) return key.pubkey;
  }
  const first = tx.transaction?.message?.accountKeys?.[0];
  return typeof first === "string" ? first : first?.pubkey;
}

export async function fetchRecentBuys(url, { nyanMint, pltrMint, treasury, until }) {
  const options = { limit: 12 };
  if (until) options.until = until;
  const sigs = await rpcCall(url, "getSignaturesForAddress", [nyanMint, options]);
  const rows = Array.isArray(sigs) ? sigs : [];
  const buys = [];
  for (const row of [...rows].reverse()) {
    if (!row?.signature || row.err) continue;
    const tx = await rpcCall(url, "getTransaction", [row.signature, {
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    }]);
    const found = parseBuyers(tx, { nyanMint, pltrMint, treasury });
    if (!found.length) continue;
    const signer = signerOf(tx);
    const chosen = found.find((buyer) => buyer.owner === signer)
      || found.sort((a, b) => (a.nyanDelta < b.nyanDelta ? 1 : -1))[0];
    const at = (row.blockTime || tx?.blockTime || 0) * 1000;
    if (at > 0) buys.push({ owner: chosen.owner, sig: row.signature, at });
  }
  return { buys, head: rows[0]?.signature || null };
}

export async function treasurySnapshot(url, treasury) {
  const sol = BigInt(await rpcCall(url, "getBalance", [treasury, { commitment: "confirmed" }]));
  let pltr = 0n;
  try {
    const accounts = await rpcCall(url, "getTokenAccountsByOwner", [
      treasury,
      { mint: PLTR_MINT },
      { encoding: "jsonParsed" },
    ]);
    for (const row of accounts?.value || []) {
      pltr += BigInt(row.account.data.parsed.info.tokenAmount.amount);
    }
  } catch {
    pltr = 0n;
  }
  return { sol, pltr, spendable: swapBudget(sol, { needsAta: false }) };
}

export async function quotePltr(lamports) {
  if (lamports <= 0n) return null;
  const url = new URL(JUPITER_QUOTE_URL);
  url.searchParams.set("inputMint", WSOL_MINT);
  url.searchParams.set("outputMint", PLTR_MINT);
  url.searchParams.set("amount", lamports.toString());
  url.searchParams.set("slippageBps", "100");
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) return null;
  const quote = await res.json();
  const out = BigInt(quote.outAmount || "0");
  if (out <= 0n) return null;
  return { out, quote };
}

export function bytesToB64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function b64ToBytes(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function connectionFor(env) {
  return new Connection(rpcUrl(env), "confirmed");
}

async function openPrizeAccount(connection, keypair, buyerKey) {
  const mint = new PublicKey(PLTR_MINT);
  const ata = getAssociatedTokenAddressSync(mint, buyerKey, false, TOKEN_2022_PROGRAM_ID);
  const info = await connection.getAccountInfo(ata);
  if (info) return { ata, opened: false };
  const balance = BigInt(await connection.getBalance(keypair.publicKey));
  if (balance < RESERVE_LAMPORTS + ATA_RENT_LAMPORTS + FEE_BUFFER_LAMPORTS) {
    throw new Error("opening the prize account would break the 0.05 SOL reserve");
  }
  const open = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(
    keypair.publicKey,
    ata,
    buyerKey,
    mint,
    TOKEN_2022_PROGRAM_ID,
  ));
  open.feePayer = keypair.publicKey;
  open.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  open.sign(keypair);
  const sig = await connection.sendRawTransaction(open.serialize(), { maxRetries: 2 });
  await connection.confirmTransaction(sig, "confirmed");
  return { ata, opened: true };
}

export async function buildTransfer(env, buyer) {
  const keypair = loadKeypair(env.TREASURY_SECRET);
  assertTreasury(env, keypair);
  const connection = connectionFor(env);
  const buyerKey = new PublicKey(buyer);
  const mint = new PublicKey(PLTR_MINT);
  const from = getAssociatedTokenAddressSync(mint, keypair.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const fromInfo = await connection.getAccountInfo(from);
  if (!fromInfo) return { empty: true };
  const snap = await treasurySnapshot(rpcUrl(env), keypair.publicKey.toBase58());
  if (snap.pltr <= 0n) return { empty: true };
  if (snap.sol < RESERVE_LAMPORTS + FEE_BUFFER_LAMPORTS) {
    throw new Error("PLTRx transfer would break the 0.05 SOL reserve");
  }
  const { ata } = await openPrizeAccount(connection, keypair, buyerKey);
  const tx = new Transaction().add(createTransferCheckedInstruction(
    from,
    mint,
    ata,
    keypair.publicKey,
    snap.pltr,
    PLTR_DECIMALS,
    [],
    TOKEN_2022_PROGRAM_ID,
  ));
  tx.feePayer = keypair.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(keypair);
  const raw = tx.serialize();
  return {
    empty: false,
    sig: bs58.encode(tx.signature),
    raw: bytesToB64(raw),
    out: snap.pltr.toString(),
  };
}

export async function buildSwap(env, buyer) {
  const keypair = loadKeypair(env.TREASURY_SECRET);
  assertTreasury(env, keypair);
  const connection = connectionFor(env);
  const buyerKey = new PublicKey(buyer);
  const { ata } = await openPrizeAccount(connection, keypair, buyerKey);
  const balance = BigInt(await connection.getBalance(keypair.publicKey));
  const amount = swapBudget(balance, { needsAta: false });
  if (amount <= 0n) return { empty: true };
  const quoted = await quotePltr(amount);
  if (!quoted) throw new Error("no PLTR quote");
  const res = await fetch(JUPITER_SWAP_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quoted.quote,
      userPublicKey: keypair.publicKey.toBase58(),
      destinationTokenAccount: ata.toBase58(),
      dynamicComputeUnitLimit: true,
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: 200_000, priorityLevel: "medium" },
      },
    }),
  });
  if (!res.ok) throw new Error(`Jupiter swap ${res.status}`);
  const built = await res.json();
  if (!built.swapTransaction) throw new Error("Jupiter returned no transaction");
  const tx = VersionedTransaction.deserialize(b64ToBytes(built.swapTransaction));
  tx.sign([keypair]);
  const signed = tx.serialize();
  return {
    empty: false,
    sig: bs58.encode(tx.signatures[0]),
    raw: bytesToB64(signed),
    out: quoted.out.toString(),
  };
}

function assertTreasury(env, keypair) {
  const pinned = String(env.TREASURY_PUBKEY || "").trim();
  if (pinned && pinned !== keypair.publicKey.toBase58()) {
    throw new Error("treasury key does not match TREASURY_PUBKEY");
  }
}

export async function sendSigned(env, rawB64) {
  const connection = connectionFor(env);
  return connection.sendRawTransaction(b64ToBytes(rawB64), { skipPreflight: false, maxRetries: 2 });
}

export async function signatureStatus(env, sig) {
  const result = await rpcCall(rpcUrl(env), "getSignatureStatuses", [[sig], { searchTransactionHistory: true }]);
  const row = result?.value?.[0];
  if (!row) return "unknown";
  if (row.err) return "err";
  if (row.confirmationStatus === "confirmed" || row.confirmationStatus === "finalized") return "done";
  return "pending";
}
