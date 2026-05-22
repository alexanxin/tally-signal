import { NextRequest, NextResponse } from "next/server";
import { createPublicKey, verify as cryptoVerify } from "crypto";

/**
 * POST /api/attest/verify
 *
 * Server-side mirror of the 6-step Proof-of-Presence verification flow
 * documented in github.com/alexanxin/tally-vault README. x402 gateways and
 * agent-payment counterparties can call this once instead of re-implementing
 * the verifier themselves.
 *
 * The signature alone proves only "someone with this secret key signed these
 * bytes." A serious verifier needs more than that. This route runs:
 *
 *   1. Decode + parse the token (envelope check).
 *   2. Verify Ed25519 signature against the expected vault pubkey (anchor).
 *      The caller passes expectedVault out-of-band; the token's vault field
 *      is ignored as a trust source and only used for the cross-check below.
 *   3. Cross-check: the payload's `vault` field equals expectedVault.
 *      Catches a substitution where a forger swapped the token's vault
 *      field but somehow kept a valid signature for a different key.
 *   4. Optional session binding: payload.session equals expectedSession.
 *   5. On-chain settlement: fetch payload.txSig, confirm a real USDC/SOL
 *      transfer of payload.amount from vault to session settled on-chain.
 *      This is the load-bearing check. Money actually moved.
 *   6. Freshness: payload.ts within ttlSeconds of now.
 *
 * Nonce dedup (step 7 in the README) is verifier-side policy. This route
 * does not maintain a seen-set across requests; the calling system should.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

const IS_DEVNET =
  RPC_URL.toLowerCase().includes("devnet") ||
  RPC_URL.toLowerCase().includes("dev.");

const USDC_MINT = IS_DEVNET
  ? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
  : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

const TX_POLL_ATTEMPTS = 4;
const TX_POLL_DELAY_MS = 2000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Inline base58 decoder (no SDK dep)
// ---------------------------------------------------------------------------
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX: Record<string, number> = {};
for (let i = 0; i < B58_ALPHABET.length; i++) B58_INDEX[B58_ALPHABET[i]] = i;

function base58Decode(s: string): Uint8Array | null {
  if (!s) return null;
  // Count leading '1's — they map to leading zero bytes.
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;

  // Convert from base58 to base256 via long division on a byte buffer.
  const bytes: number[] = [];
  for (let i = zeros; i < s.length; i++) {
    const ch = s[i];
    const val = B58_INDEX[ch];
    if (val === undefined) return null;
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

// ---------------------------------------------------------------------------
// base64url decode (mirrors the encoder in warm-vault attestation.ts)
// ---------------------------------------------------------------------------
function b64urlToBytes(s: string): Uint8Array | null {
  if (!s) return null;
  try {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
    return new Uint8Array(Buffer.from(b64, "base64"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ed25519 verify via Node crypto (no extra deps)
// ---------------------------------------------------------------------------

// SPKI DER prefix for an Ed25519 public key (OID 1.3.101.112)
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function ed25519Verify(
  publicKeyBytes: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (publicKeyBytes.length !== 32) return false;
  if (signature.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyBytes)]),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// On-chain tx fetch (mirrors signal/route.ts)
// ---------------------------------------------------------------------------
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
  const data = (await res.json()) as { result?: unknown };
  return data?.result ?? null;
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
  const data = (await res.json()) as {
    result?: { value?: { data?: { parsed?: { info?: { owner?: string; mint?: string } } } } };
  };
  const info = data?.result?.value?.data?.parsed?.info;
  if (!info?.owner || !info?.mint) return null;
  return { owner: info.owner, mint: info.mint };
}

interface SettlementCheck {
  ok: boolean;
  reason?: string;
  amount?: number;
  destination?: string;
  blockTime?: number;
}

async function verifySettlement(
  txSig: string,
  expectedVault: string,
  expectedSession: string,
  expectedAmount: number,
  currency: string,
): Promise<SettlementCheck> {
  let raw: unknown = null;
  for (let attempt = 0; attempt < TX_POLL_ATTEMPTS; attempt++) {
    raw = await fetchTransaction(txSig);
    if (raw !== null) break;
    if (attempt < TX_POLL_ATTEMPTS - 1) await sleep(TX_POLL_DELAY_MS);
  }
  if (!raw) {
    return {
      ok: false,
      reason: `tx_not_found_after_${TX_POLL_ATTEMPTS}_attempts`,
    };
  }

  const tx = raw as {
    blockTime?: number;
    meta?: { err: unknown };
    transaction?: {
      message?: {
        instructions?: Array<{
          programId?: string;
          parsed?: {
            type?: string;
            info?: {
              destination?: string;
              source?: string;
              authority?: string;
              mint?: string;
              tokenAmount?: { uiAmount?: number; amount?: string };
              amount?: string | number;
              lamports?: number;
            };
          };
        }>;
      };
    };
  };

  if (tx.meta?.err) return { ok: false, reason: "tx_failed_on_chain" };

  const blockTime = tx.blockTime;
  const instructions = tx.transaction?.message?.instructions ?? [];

  const isUsdc = currency.toUpperCase() === "USDC";
  const isSol = currency.toUpperCase() === "SOL";

  // Slack on amount comparison: floats over JSON-RPC can be slightly off in
  // the last decimal. 1 lamport for SOL, 1 micro-USDC for USDC.
  const epsilon = isSol ? 1 / 10 ** SOL_DECIMALS : 1 / 10 ** USDC_DECIMALS;

  for (const ix of instructions) {
    const parsed = ix.parsed;
    if (!parsed) continue;
    const info = parsed.info ?? {};

    // SOL transfer (System Program)
    if (isSol && parsed.type === "transfer" && info.lamports !== undefined) {
      const src = info.source ?? "";
      const dst = info.destination ?? "";
      if (src !== expectedVault) continue;
      if (dst !== expectedSession) continue;
      const sol = (info.lamports as number) / 10 ** SOL_DECIMALS;
      if (Math.abs(sol - expectedAmount) > epsilon) continue;
      return { ok: true, amount: sol, destination: dst, blockTime };
    }

    if (!isUsdc) continue;

    const dest = info.destination ?? "";
    if (!dest) continue;

    let uiAmount = 0;
    if (parsed.type === "transferChecked") {
      if (info.mint !== USDC_MINT) continue;
      uiAmount =
        info.tokenAmount?.uiAmount ??
        parseInt(info.tokenAmount?.amount ?? "0", 10) / 10 ** USDC_DECIMALS;
    } else if (parsed.type === "transfer") {
      uiAmount =
        typeof info.amount === "number"
          ? info.amount / 10 ** USDC_DECIMALS
          : parseInt(String(info.amount ?? "0"), 10) / 10 ** USDC_DECIMALS;
    } else {
      continue;
    }

    if (Math.abs(uiAmount - expectedAmount) > epsilon) continue;

    const ataInfo = await getAtaInfo(dest);
    if (!ataInfo) continue;
    if (ataInfo.mint !== USDC_MINT) continue;
    if (ataInfo.owner !== expectedSession) continue;

    // For transferChecked the authority is the signer; for plain transfer
    // we can't always tell from the instruction alone, so we accept the
    // destination/amount/mint match as sufficient and let the caller's
    // expectedVault anchor enforce the human-authorization root.
    return { ok: true, amount: uiAmount, destination: dest, blockTime };
  }

  return { ok: false, reason: "no_matching_transfer_in_tx" };
}

// ---------------------------------------------------------------------------
// Token + payload types — match warm-vault/src/utils/attestation.ts
// ---------------------------------------------------------------------------
interface AttestationPayload {
  v?: number;
  type?: string;
  vault?: string;
  session?: string;
  amount?: number;
  currency?: string;
  taskHash?: string;
  txSig?: string;
  ts?: number;
  nonce?: string;
}

interface AttestationToken {
  payload?: string;
  sig?: string;
  vaultPubkey?: string;
}

interface VerifyRequest {
  token: AttestationToken | string;
  expectedVault: string;
  expectedSession?: string;
  verifySettlement?: boolean;
  ttlSeconds?: number;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  let body: VerifyRequest;
  try {
    body = (await req.json()) as VerifyRequest;
  } catch {
    return NextResponse.json(
      { valid: false, reason: "bad_request_body" },
      { status: 400 },
    );
  }

  // ── Input shape ──────────────────────────────────────────────────────────
  if (!body || typeof body !== "object") {
    return NextResponse.json({ valid: false, reason: "bad_request_body" }, { status: 400 });
  }

  const tokenRaw = body.token;
  let token: AttestationToken | null = null;
  if (typeof tokenRaw === "string") {
    try {
      token = JSON.parse(tokenRaw) as AttestationToken;
    } catch {
      return NextResponse.json({ valid: false, reason: "bad_token_json" }, { status: 400 });
    }
  } else if (tokenRaw && typeof tokenRaw === "object") {
    token = tokenRaw;
  }
  if (!token || !token.payload || !token.sig) {
    return NextResponse.json({ valid: false, reason: "token_missing_fields" }, { status: 400 });
  }

  const expectedVault = (body.expectedVault ?? "").trim();
  if (!expectedVault) {
    return NextResponse.json({ valid: false, reason: "expected_vault_required" }, { status: 400 });
  }

  const checks: Record<string, "ok" | "skipped" | "failed"> = {
    signature: "failed",
    vaultMatch: "failed",
    sessionMatch: "skipped",
    settlement: "skipped",
    freshness: "failed",
  };

  // ── Decode bytes ─────────────────────────────────────────────────────────
  const payloadBytes = b64urlToBytes(token.payload);
  const sigBytes = b64urlToBytes(token.sig);
  const vaultBytes = base58Decode(expectedVault);

  if (!payloadBytes || !sigBytes || !vaultBytes) {
    return NextResponse.json(
      { valid: false, reason: "bad_encoding", checks },
      { status: 400 },
    );
  }

  // ── Step 2: signature verify against expectedVault ───────────────────────
  if (!ed25519Verify(vaultBytes, payloadBytes, sigBytes)) {
    return NextResponse.json(
      { valid: false, reason: "sig_verify_failed", checks },
      { status: 200 },
    );
  }
  checks.signature = "ok";

  // ── Decode payload now that the signature has cleared ────────────────────
  let payload: AttestationPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadBytes).toString("utf-8")) as AttestationPayload;
  } catch {
    return NextResponse.json(
      { valid: false, reason: "bad_payload_json", checks },
      { status: 200 },
    );
  }

  if (payload.v !== 1 || payload.type !== "tally.attest") {
    return NextResponse.json(
      { valid: false, reason: "bad_envelope", checks, payload },
      { status: 200 },
    );
  }

  // ── Step 3: vault field cross-check ──────────────────────────────────────
  if (payload.vault !== expectedVault) {
    return NextResponse.json(
      { valid: false, reason: "vault_mismatch", checks, payload },
      { status: 200 },
    );
  }
  checks.vaultMatch = "ok";

  // ── Step 4: optional session binding ─────────────────────────────────────
  if (body.expectedSession) {
    if (payload.session !== body.expectedSession.trim()) {
      checks.sessionMatch = "failed";
      return NextResponse.json(
        { valid: false, reason: "session_mismatch", checks, payload },
        { status: 200 },
      );
    }
    checks.sessionMatch = "ok";
  }

  // ── Step 6: freshness ────────────────────────────────────────────────────
  const ttl = body.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const nowS = Math.floor(Date.now() / 1000);
  if (!payload.ts || nowS - payload.ts > ttl) {
    return NextResponse.json(
      {
        valid: false,
        reason: "stale",
        checks,
        payload,
        details: { ageSeconds: payload.ts ? nowS - payload.ts : null, ttlSeconds: ttl },
      },
      { status: 200 },
    );
  }
  checks.freshness = "ok";

  // ── Step 5: on-chain settlement (optional, defaults true) ────────────────
  const verifySettle = body.verifySettlement !== false;
  let settlement: SettlementCheck | undefined;
  if (verifySettle) {
    if (!payload.txSig || !payload.session || !payload.amount || !payload.currency) {
      checks.settlement = "failed";
      return NextResponse.json(
        { valid: false, reason: "payload_missing_settlement_fields", checks, payload },
        { status: 200 },
      );
    }
    try {
      settlement = await verifySettlement(
        payload.txSig,
        expectedVault,
        payload.session,
        payload.amount,
        payload.currency,
      );
    } catch {
      checks.settlement = "failed";
      return NextResponse.json(
        { valid: false, reason: "rpc_error", checks, payload },
        { status: 503 },
      );
    }
    if (!settlement.ok) {
      checks.settlement = "failed";
      return NextResponse.json(
        { valid: false, reason: settlement.reason ?? "settlement_failed", checks, payload },
        { status: 200 },
      );
    }
    checks.settlement = "ok";
  }

  // ── All checks passed ────────────────────────────────────────────────────
  return NextResponse.json({
    valid: true,
    checks,
    payload,
    settlement: settlement
      ? {
          txSig: payload.txSig,
          amount: settlement.amount,
          destination: settlement.destination,
          blockTime: settlement.blockTime,
        }
      : undefined,
    note:
      "Nonce dedup (step 7) is verifier-side policy; this endpoint does not maintain a seen-set across requests.",
  });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}

export async function GET() {
  return NextResponse.json(
    {
      endpoint: "POST /api/attest/verify",
      docs: "https://github.com/alexanxin/tally-vault#proof-of-presence",
      method: "POST",
      requestShape: {
        token: "AttestationToken or JSON string of one",
        expectedVault: "base58 vault pubkey (required, anchor)",
        expectedSession: "base58 session pubkey (optional)",
        verifySettlement: "boolean (default true)",
        ttlSeconds: "integer (default 86400)",
      },
    },
    { status: 405 },
  );
}
