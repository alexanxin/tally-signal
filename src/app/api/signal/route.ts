import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

const MIN_BALANCE =
  parseFloat(process.env.SIGNAL_MIN_BALANCE ?? "0.5");

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
// 402 response helpers
// ---------------------------------------------------------------------------
function paymentRequired(extra?: Record<string, unknown>) {
  return NextResponse.json(
    {
      error: "payment_required",
      message: "This endpoint requires a funded Tally session wallet.",
      amount: MIN_BALANCE,
      currency: "USDC",
      how_to_pay:
        "Fund a session wallet via the Tally app, then retry with header: X-Tally-Session: <pubkey>",
      ...extra,
    },
    {
      status: 402,
      headers: {
        "X-Payment-Required": "tally",
        "X-Payment-Amount": String(MIN_BALANCE),
        "X-Payment-Currency": "USDC",
      },
    }
  );
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  const sessionPubkey =
    req.headers.get("x-tally-session") ??
    req.nextUrl.searchParams.get("session") ??
    "";

  // ── No session header → 402 ───────────────────────────────────────────────
  if (!sessionPubkey.trim()) {
    return paymentRequired();
  }

  // ── Session header present → verify on-chain balance ─────────────────────
  let balance: number;
  try {
    balance = await getUsdcBalance(sessionPubkey.trim());
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

  // ── Balance OK → fetch signal (price + generation run in parallel with
  //    balance check above via Promise.all at call site if needed; here
  //    balance is already confirmed so we just await the signal)
  const signal = await generateSignal();

  return NextResponse.json({
    ok: true,
    session: sessionPubkey,
    balance: +balance.toFixed(4),
    signal,
  });
}

// Support OPTIONS preflight
export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
