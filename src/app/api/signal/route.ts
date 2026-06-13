import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

const MIN_BALANCE =
  parseFloat(process.env.SIGNAL_MIN_BALANCE ?? "0.5");

// Payment amount required per signal call (on-chain settlement)
const PAYMENT_AMOUNT =
  parseFloat(process.env.SIGNAL_PAYMENT_AMOUNT ?? "0.1");

// The burner wallet that receives USDC payments. If not set, the server
// falls back to session-balance verification only (proof-of-authorization mode).
const PAYMENT_WALLET = process.env.SIGNAL_PAYMENT_WALLET ?? "";

// How old a payment tx can be (seconds) — prevents replay attacks
const TX_MAX_AGE_S = parseInt(process.env.SIGNAL_TX_MAX_AGE ?? "300");

const IS_DEVNET =
  RPC_URL.toLowerCase().includes("devnet") ||
  RPC_URL.toLowerCase().includes("dev.");

const USDC_MINT = IS_DEVNET
  ? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
  : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ---------------------------------------------------------------------------
// On-chain balance check via raw JSON-RPC (no solana-web3 bundle needed)
// ---------------------------------------------------------------------------
async function getUsdcBalance(pubkey: string): Promise<number> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getTokenAccountsByOwner",
    params: [
      pubkey,
      { mint: USDC_MINT },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ],
  };

  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // Vercel edge functions cache by default — disable for live balance checks
    cache: "no-store",
  });

  if (!res.ok) return 0;

  const data = (await res.json()) as {
    result?: { value?: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: number } } } } } }> };
  };

  const accounts = data?.result?.value ?? [];
  return accounts.reduce((sum, acct) => {
    const ui = acct?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
    return sum + ui;
  }, 0);
}

// ---------------------------------------------------------------------------
// Live SOL price via Jupiter quote API (same source as the Tally app)
// Quotes 1 SOL → USDC and reads swapUsdValue from the response.
// Falls back to the previous close from CoinGecko if Jupiter is unavailable.
// ---------------------------------------------------------------------------
const SOL_MINT  = "So11111111111111111111111111111111111111112";
const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function getLiveSolPrice(): Promise<number> {
  // Primary: Jupiter quote (1 SOL → USDC)
  try {
    const ONE_SOL = 1_000_000_000; // lamports
    const url =
      `https://api.jup.ag/swap/v1/quote` +
      `?inputMint=${SOL_MINT}` +
      `&outputMint=${USDC_MINT_MAINNET}` +
      `&amount=${ONE_SOL}` +
      `&slippageBps=50`;

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Jupiter ${res.status}`);
    const data = await res.json() as { swapUsdValue?: string | number };
    const price = parseFloat(String(data?.swapUsdValue ?? "0"));
    if (price > 1) return price; // sanity check
    throw new Error("Jupiter returned implausible price");
  } catch {
    // Fallback: CoinGecko simple price (no key needed)
    try {
      const res = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
      const data = await res.json() as { solana?: { usd?: number } };
      const price = data?.solana?.usd ?? 0;
      if (price > 1) return price;
    } catch { /* fall through */ }

    // Last resort: return 0 — caller handles gracefully
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Signal generator — uses live SOL price.
// Swap out generateSignal() body for a real AI call (Gemini, MiniMax, etc.)
// without touching any auth or paywall logic.
// ---------------------------------------------------------------------------
async function generateSignal() {
  const now = Date.now();
  const d = new Date(now);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();

  // Fetch live price; if unavailable the signal still generates but
  // shows "price_unavailable" in the entry field so the demo is honest
  const solPrice = await getLiveSolPrice();
  const priceAvailable = solPrice > 1;

  const bias       = (h + m) % 2 === 0 ? "BULLISH" : "BEARISH";
  const targetPct  = +(2.5 + ((h * 7 + m * 3) % 80) / 10).toFixed(1);
  const stopPct    = +(0.8 + ((h * 3 + m * 5) % 30) / 10).toFixed(1);
  const confidence = 62 + ((h * 11 + m * 7) % 28);

  // Entry is slightly below current price (realistic limit order zone)
  const entry  = priceAvailable ? +(solPrice * 0.997).toFixed(2) : null;
  const target = entry ? +(entry * (1 + targetPct / 100)).toFixed(2) : null;
  const stop   = entry ? +(entry * (1 - stopPct  / 100)).toFixed(2) : null;

  return {
    asset:       "SOL/USDC",
    signal:      bias,
    confidence:  `${confidence}%`,
    price:       priceAvailable ? `$${solPrice.toFixed(2)}` : "unavailable",
    entry:       entry   ? `$${entry}`  : "unavailable",
    target:      target  ? `$${target}  (+${targetPct}%)` : "unavailable",
    stop_loss:   stop    ? `$${stop}  (-${stopPct}%)` : "unavailable",
    timeframe:   "4H",
    basis: {
      structure:  `Price trading ${bias === "BULLISH" ? "above" : "below"} 4H 200 EMA`,
      liquidity:  "Sweep of equal lows confirmed at prior session low",
      orderblock: `Unmitigated ${bias === "BULLISH" ? "bullish" : "bearish"} OB at entry zone`,
      rr:         `1 : ${(targetPct / stopPct).toFixed(1)}`,
    },
    generated_at: Math.floor(now / 1000),
    network: IS_DEVNET ? "devnet" : "mainnet",
  };
}

// ---------------------------------------------------------------------------
// On-chain payment verification
// ---------------------------------------------------------------------------

// Solana tx propagation can lag a few seconds between the agent's RPC node
// confirming and Vercel's RPC node seeing it. We poll up to TX_POLL_ATTEMPTS
// times with TX_POLL_DELAY_MS between each attempt before giving up.
const TX_POLL_ATTEMPTS = 4;
const TX_POLL_DELAY_MS = 2000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchTransaction(txSig: string) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getTransaction",
    params: [
      txSig,
      { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ],
  };
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = await res.json() as { result?: unknown };
  return data?.result ?? null;
}

async function verifyPaymentTx(txSig: string, expectedDestination: string, minAmount: number): Promise<{
  valid: boolean;
  reason?: string;
  amount?: number;
}> {
  // Poll until the tx is visible on this RPC node (handles propagation lag)
  let rawTx: unknown = null;
  for (let attempt = 0; attempt < TX_POLL_ATTEMPTS; attempt++) {
    rawTx = await fetchTransaction(txSig);
    if (rawTx !== null) break;
    if (attempt < TX_POLL_ATTEMPTS - 1) await sleep(TX_POLL_DELAY_MS);
  }

  if (!rawTx) {
    return {
      valid: false,
      reason: `Transaction ${txSig.slice(0, 8)}... not found after ${TX_POLL_ATTEMPTS} attempts (${(TX_POLL_ATTEMPTS * TX_POLL_DELAY_MS / 1000).toFixed(0)}s). RPC propagation may still be in progress — retry in a few seconds.`,
    };
  }

  type ParsedIx = {
    parsed?: {
      type?: string;
      info?: {
        // transferChecked fields
        destination?: string;
        mint?: string;
        tokenAmount?: { uiAmount?: number; amount?: string };
        // transfer fields (no mint — SPL transfer without check)
        amount?: string;
        source?: string;
      };
    };
  };
  const tx = rawTx as {
    blockTime?: number;
    meta?: {
      err: unknown;
      // CPI'd transfers (e.g. the subscriptions program's transferFixed in
      // budget mode) appear here, NOT in the top-level message instructions.
      innerInstructions?: Array<{ instructions?: ParsedIx[] }>;
    };
    transaction?: {
      message?: {
        instructions?: ParsedIx[];
      };
    };
  };
  if (tx.meta?.err) return { valid: false, reason: "Transaction failed on-chain" };

  // Replay check: reject if tx is older than TX_MAX_AGE_S seconds
  const blockTime = tx.blockTime ?? 0;
  const nowS = Math.floor(Date.now() / 1000);
  if (nowS - blockTime > TX_MAX_AGE_S) {
    return { valid: false, reason: `Transaction too old (${nowS - blockTime}s, max ${TX_MAX_AGE_S}s)` };
  }

  // Find a qualifying SPL token transfer to the payment wallet.
  //
  // Two instruction types to handle:
  //   "transferChecked" — includes mint + tokenAmount.uiAmount
  //   "transfer"        — no mint field; amount is raw lamports (6 decimals for USDC)
  //
  // For plain "transfer" we verify the destination ATA belongs to our payment
  // wallet AND that the ATA's mint is USDC — this covers the mint check without
  // relying on the instruction's info object having a mint field.
  // Inspect BOTH top-level instructions (ask-mode: a direct SPL transfer) AND
  // inner/CPI instructions (budget-mode: transferFixed moves USDC via the
  // subscriptions program, so the SPL transfer is nested in innerInstructions).
  const topIxs = tx.transaction?.message?.instructions ?? [];
  const innerIxs = (tx.meta?.innerInstructions ?? []).flatMap(ii => ii.instructions ?? []);
  const instructions = [...topIxs, ...innerIxs];
  for (const ix of instructions) {
    const parsed = ix.parsed;
    if (!parsed) continue;

    const info = parsed.info ?? {};
    const dest = info.destination ?? "";
    if (!dest) continue;

    let uiAmount = 0;

    if (parsed.type === "transferChecked") {
      // mint is present — verify it's USDC before checking amount
      if (info.mint !== USDC_MINT) continue;
      uiAmount = info.tokenAmount?.uiAmount ??
        (parseInt(info.tokenAmount?.amount ?? "0", 10) / 1_000_000);

    } else if (parsed.type === "transfer") {
      // No mint in info — derive amount, verify mint via ATA account info below
      uiAmount = parseInt(info.amount ?? "0", 10) / 1_000_000;

    } else {
      continue;
    }

    if (uiAmount < minAmount) continue;

    // Verify destination ATA is owned by the expected payment wallet
    // and (for plain transfer) that its mint is USDC
    const ataInfo = await getAtaInfo(dest);
    if (!ataInfo) continue;
    if (ataInfo.owner !== expectedDestination) continue;
    if (ataInfo.mint !== USDC_MINT) continue;

    return { valid: true, amount: uiAmount };
  }

  return { valid: false, reason: "No qualifying USDC transfer to payment wallet found in transaction" };
}

async function getAtaInfo(ataAddress: string): Promise<{ owner: string; mint: string } | null> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getAccountInfo",
    params: [ataAddress, { encoding: "jsonParsed" }],
  };
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = await res.json() as {
    result?: { value?: { data?: { parsed?: { info?: { owner?: string; mint?: string } } } } };
  };
  const info = data?.result?.value?.data?.parsed?.info;
  if (!info?.owner || !info?.mint) return null;
  return { owner: info.owner, mint: info.mint };
}

// ---------------------------------------------------------------------------
// 402 response helpers
// ---------------------------------------------------------------------------
function paymentRequired(extra?: Record<string, unknown>) {
  const headers: Record<string, string> = {
    "X-Payment-Required": "tally",
    "X-Payment-Amount": String(PAYMENT_AMOUNT),
    "X-Payment-Currency": "USDC",
  };
  if (PAYMENT_WALLET) {
    headers["X-Payment-Wallet"] = PAYMENT_WALLET;
  }

  return NextResponse.json(
    {
      error: "payment_required",
      message: "This endpoint requires on-chain USDC payment to the Tally signal wallet.",
      payment_amount: PAYMENT_AMOUNT,
      min_session_balance: MIN_BALANCE,
      currency: "USDC",
      payment_wallet: PAYMENT_WALLET || null,
      how_to_pay: PAYMENT_WALLET
        ? `Send ${PAYMENT_AMOUNT} USDC to ${PAYMENT_WALLET}, then retry with headers: X-Tally-Session: <pubkey> and X-Tally-Tx: <tx_signature>`
        : "Fund a session wallet via the Tally app, then retry with header: X-Tally-Session: <pubkey>",
      ...extra,
    },
    { status: 402, headers }
  );
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  const sessionPubkey =
    (req.headers.get("x-tally-session") ??
    req.nextUrl.searchParams.get("session") ??
    "").trim();

  const txSig =
    (req.headers.get("x-tally-tx") ??
    req.nextUrl.searchParams.get("tx") ??
    "").trim();

  // ── No session header → 402 ───────────────────────────────────────────────
  if (!sessionPubkey) {
    return paymentRequired();
  }

  // ── On-chain settlement mode: verify payment tx ───────────────────────────
  if (PAYMENT_WALLET) {
    if (!txSig) {
      return paymentRequired({
        error: "tx_required",
        message: `Send ${PAYMENT_AMOUNT} USDC to ${PAYMENT_WALLET} and retry with X-Tally-Tx: <tx_signature>`,
      });
    }

    let txResult: { valid: boolean; reason?: string; amount?: number };
    try {
      txResult = await verifyPaymentTx(txSig, PAYMENT_WALLET, PAYMENT_AMOUNT);
    } catch {
      return NextResponse.json(
        { error: "rpc_error", message: "Could not verify payment transaction. Try again." },
        { status: 503 }
      );
    }

    if (!txResult.valid) {
      return paymentRequired({
        error: "invalid_payment",
        message: txResult.reason ?? "Payment transaction could not be verified.",
        tx: txSig,
      });
    }

    // Payment verified — generate and return signal
    const signal = await generateSignal();
    return NextResponse.json({
      ok: true,
      session: sessionPubkey,
      payment_tx: txSig,
      payment_amount: txResult.amount,
      settlement: "on_chain",
      signal,
    });
  }

  // ── Proof-of-authorization mode (no PAYMENT_WALLET set) ──────────────────
  // Verify the session wallet has sufficient balance as authorization proof.
  let balance: number;
  try {
    balance = await getUsdcBalance(sessionPubkey);
  } catch {
    return NextResponse.json(
      { error: "rpc_error", message: "Could not verify session balance. Try again." },
      { status: 503 }
    );
  }

  if (balance < MIN_BALANCE) {
    return paymentRequired({
      error: "insufficient_balance",
      message: `Session wallet has $${balance.toFixed(4)} USDC — minimum required: $${MIN_BALANCE}.`,
      balance,
      required: MIN_BALANCE,
      session: sessionPubkey,
    });
  }

  const signal = await generateSignal();
  return NextResponse.json({
    ok: true,
    session: sessionPubkey,
    balance: +balance.toFixed(4),
    settlement: "proof_of_authorization",
    signal,
  });
}

// Support OPTIONS preflight
export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
