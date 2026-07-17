import { NextRequest, NextResponse } from "next/server";
import { createHash, createPublicKey, verify as cryptoVerify } from "crypto";

/**
 * POST /api/attest/verify-authority
 *
 * Public verifier for the Tally spend-authority attestation — the INTENT
 * credential: "human H authorized agent A to spend up to X of asset M until T,
 * enforced by delegation PDA D." Spec: documentation/Specs/
 * tally-attestation-spec-v0.1.md (domain tally.spend-auth.v1).
 *
 * Mirrors tally_integration/attestation.py exactly:
 *
 *   verify_attestation:
 *     1. envelope: payload is an object, domain == "tally.spend-auth.v1"
 *     2. digest:   sha256(canonical_json(payload)).hex == digest_sha256_hex
 *        (canonical = sorted keys, no whitespace)
 *     3. issuer:   optional pin — pubkey_b58 == expectedIssuer
 *     4. sig:      ed25519_verify(signature_b58, pubkey_b58,
 *                  message = domain + "\n" + digest)
 *
 *   cross_check_allowance (the on-chain half; the signature is never trusted
 *   alone): fetch payload.delegationPda, require a live De1egAF FixedDelegation
 *   where delegator == payload.vault, delegatee == payload.agent,
 *   expiryTs > now, and remaining >= payload.capAtomic.
 *
 * The companion endpoint /api/attest/verify checks the Proof-of-Presence
 * spend RECEIPT (a payment happened); this one checks the spend AUTHORITY
 * (a human granted it). Together they close the provenance chain:
 * human approval -> bounded authority -> settled draw.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DOMAIN = "tally.spend-auth.v1";

// FixedDelegation program + account layout (mirrors warm_vault_auth.py _FD_*)
const DELEGATION_PROGRAM = "De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44";
const FD_SIZE = 187;
const FD_OFF_DELEGATOR = 3; // disc(1) version(1) bump(1), then delegator(32)
const FD_OFF_DELEGATEE = 35; // then delegatee(32)
const FD_OFF_AMOUNT = 171; // ...payer(32) initId(8) subAuthority(32) mint(32), then amount u64le
const FD_OFF_EXPIRY = 179; // then expiryTs i64le

const USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

// Fixed RPC endpoints only — request bodies never supply URLs.
const MAINNET_RPC =
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const DEVNET_RPC =
  process.env.SOLANA_DEVNET_RPC_URL ?? "https://api.devnet.solana.com";

// ---------------------------------------------------------------------------
// Inline base58 decoder (no SDK dep; same as ../verify/route.ts)
// ---------------------------------------------------------------------------
const B58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX: Record<string, number> = {};
for (let i = 0; i < B58_ALPHABET.length; i++) B58_INDEX[B58_ALPHABET[i]] = i;

function base58Decode(s: string): Uint8Array | null {
  if (!s) return null;
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < s.length; i++) {
    const val = B58_INDEX[s[i]];
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
  for (let i = 0; i < bytes.length; i++)
    out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

// ---------------------------------------------------------------------------
// Ed25519 verify via Node crypto (no extra deps)
// ---------------------------------------------------------------------------
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
// Canonical JSON — byte-identical to Python json.dumps(sort_keys=True,
// separators=(",", ":")) for this payload (flat object, ASCII strings,
// integer numbers). Same recipe the issuers use (attestation.py /
// warm-vault src/lib/agentid/attestation.ts, byte-match proven by test).
// ---------------------------------------------------------------------------
function canonicalJson(payload: Record<string, unknown>): string {
  const obj: Record<string, unknown> = {};
  for (const k of Object.keys(payload).sort()) obj[k] = payload[k];
  return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// Envelope types — match attestation.py issue_attestation
// ---------------------------------------------------------------------------
interface SpendAuthPayload {
  vault?: string;
  agent?: string;
  mint?: string;
  capAtomic?: number;
  expiryTs?: number;
  delegationPda?: string;
  issuedTs?: number;
}

interface SpendAuthAttestation {
  alg?: string;
  domain?: string;
  payload?: SpendAuthPayload;
  digest_sha256_hex?: string;
  pubkey_b58?: string;
  signature_b58?: string;
}

interface VerifyAuthorityRequest {
  attestation: SpendAuthAttestation | string;
  expectedIssuer?: string;
  verifyAllowance?: boolean; // default true
  cluster?: "devnet" | "mainnet"; // default: inferred from payload.mint
}

// ---------------------------------------------------------------------------
// On-chain allowance cross-check (direct account fetch — no getProgramAccounts,
// so it works on any RPC tier)
// ---------------------------------------------------------------------------
interface AllowanceCheck {
  ok: boolean;
  reason?: string;
  remainingBaseUnits?: string;
  expiryTs?: number;
  cluster?: string;
}

async function crossCheckAllowance(
  payload: Required<Pick<SpendAuthPayload, "vault" | "agent" | "delegationPda" | "capAtomic">> &
    SpendAuthPayload,
  rpcUrl: string,
  clusterName: string,
): Promise<AllowanceCheck> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [payload.delegationPda, { encoding: "base64", commitment: "confirmed" }],
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`rpc_http_${res.status}`);
  const body = (await res.json()) as {
    result?: { value?: { owner?: string; data?: [string, string] } | null };
  };
  const value = body?.result?.value;
  if (!value) return { ok: false, reason: "allowance_not_found", cluster: clusterName };
  if (value.owner !== DELEGATION_PROGRAM)
    return { ok: false, reason: "allowance_wrong_program", cluster: clusterName };

  const data = Buffer.from(value.data?.[0] ?? "", "base64");
  if (data.length < FD_SIZE)
    return { ok: false, reason: "allowance_bad_account_size", cluster: clusterName };

  const vaultBytes = base58Decode(payload.vault);
  const agentBytes = base58Decode(payload.agent);
  if (!vaultBytes || !agentBytes)
    return { ok: false, reason: "bad_payload_pubkeys", cluster: clusterName };

  const delegator = data.subarray(FD_OFF_DELEGATOR, FD_OFF_DELEGATOR + 32);
  const delegatee = data.subarray(FD_OFF_DELEGATEE, FD_OFF_DELEGATEE + 32);
  if (!delegator.equals(Buffer.from(vaultBytes)))
    return { ok: false, reason: "allowance_delegator_mismatch", cluster: clusterName };
  if (!delegatee.equals(Buffer.from(agentBytes)))
    return { ok: false, reason: "allowance_delegatee_mismatch", cluster: clusterName };

  const remaining = data.readBigUInt64LE(FD_OFF_AMOUNT);
  const expiry = data.readBigInt64LE(FD_OFF_EXPIRY);
  const nowS = BigInt(Math.floor(Date.now() / 1000));

  const base: AllowanceCheck = {
    ok: false,
    remainingBaseUnits: remaining.toString(),
    expiryTs: Number(expiry),
    cluster: clusterName,
  };
  if (expiry <= nowS) return { ...base, reason: "allowance_expired" };
  // Python cross_check_allowance requires cap_atomic (remaining) >= attested cap:
  // the allowance must still be intact at the attested level.
  if (remaining < BigInt(Math.trunc(payload.capAtomic)))
    return { ...base, reason: "allowance_below_attested_cap" };
  return { ...base, ok: true };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  let body: VerifyAuthorityRequest;
  try {
    body = (await req.json()) as VerifyAuthorityRequest;
  } catch {
    return NextResponse.json({ valid: false, reason: "bad_request_body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ valid: false, reason: "bad_request_body" }, { status: 400 });
  }

  // Accept the envelope as an object or a JSON string of one.
  let att: SpendAuthAttestation | null = null;
  const raw = body.attestation;
  if (typeof raw === "string") {
    try {
      att = JSON.parse(raw) as SpendAuthAttestation;
    } catch {
      return NextResponse.json({ valid: false, reason: "bad_attestation_json" }, { status: 400 });
    }
  } else if (raw && typeof raw === "object") {
    att = raw;
  }
  if (!att) {
    return NextResponse.json({ valid: false, reason: "attestation_required" }, { status: 400 });
  }

  const checks: Record<string, "ok" | "skipped" | "failed"> = {
    envelope: "failed",
    digest: "failed",
    issuerMatch: "skipped",
    signature: "failed",
    allowance: "skipped",
  };

  // ── 1. Envelope ───────────────────────────────────────────────────────────
  const payload = att.payload;
  if (!payload || typeof payload !== "object" || att.domain !== DOMAIN) {
    return NextResponse.json(
      { valid: false, reason: "bad_envelope", checks },
      { status: 200 },
    );
  }
  checks.envelope = "ok";

  // ── 2. Digest recompute ───────────────────────────────────────────────────
  const digest = createHash("sha256")
    .update(canonicalJson(payload as Record<string, unknown>), "utf8")
    .digest("hex");
  if (digest !== att.digest_sha256_hex) {
    return NextResponse.json(
      { valid: false, reason: "digest_mismatch", checks },
      { status: 200 },
    );
  }
  checks.digest = "ok";

  // ── 3. Optional issuer pin ────────────────────────────────────────────────
  const pubkeyB58 = att.pubkey_b58 ?? "";
  if (body.expectedIssuer) {
    if (pubkeyB58 !== body.expectedIssuer.trim()) {
      checks.issuerMatch = "failed";
      return NextResponse.json(
        { valid: false, reason: "issuer_mismatch", checks },
        { status: 200 },
      );
    }
    checks.issuerMatch = "ok";
  }

  // ── 4. Ed25519 signature over domain + "\n" + digest ─────────────────────
  const pubkeyBytes = base58Decode(pubkeyB58);
  const sigBytes = base58Decode(att.signature_b58 ?? "");
  if (!pubkeyBytes || !sigBytes) {
    return NextResponse.json(
      { valid: false, reason: "bad_encoding", checks },
      { status: 200 },
    );
  }
  const message = Buffer.from(`${DOMAIN}\n${digest}`, "utf8");
  if (!ed25519Verify(pubkeyBytes, message, sigBytes)) {
    return NextResponse.json(
      { valid: false, reason: "sig_verify_failed", checks },
      { status: 200 },
    );
  }
  checks.signature = "ok";

  // ── 5. On-chain allowance cross-check (default true) ─────────────────────
  const doAllowance = body.verifyAllowance !== false;
  let allowance: AllowanceCheck | undefined;
  if (doAllowance) {
    if (
      !payload.vault ||
      !payload.agent ||
      !payload.delegationPda ||
      payload.capAtomic === undefined
    ) {
      checks.allowance = "failed";
      return NextResponse.json(
        { valid: false, reason: "payload_missing_allowance_fields", checks, payload },
        { status: 200 },
      );
    }
    const cluster =
      body.cluster ?? (payload.mint === USDC_MINT_DEVNET ? "devnet" : "mainnet");
    const rpcUrl = cluster === "devnet" ? DEVNET_RPC : MAINNET_RPC;
    try {
      allowance = await crossCheckAllowance(
        payload as Parameters<typeof crossCheckAllowance>[0],
        rpcUrl,
        cluster,
      );
    } catch {
      checks.allowance = "failed";
      return NextResponse.json(
        { valid: false, reason: "rpc_error", checks, payload },
        { status: 503 },
      );
    }
    if (!allowance.ok) {
      checks.allowance = "failed";
      return NextResponse.json(
        { valid: false, reason: allowance.reason ?? "allowance_failed", checks, payload, allowance },
        { status: 200 },
      );
    }
    checks.allowance = "ok";
  }

  // ── All checks passed ─────────────────────────────────────────────────────
  return NextResponse.json({
    valid: true,
    checks,
    payload,
    issuer: pubkeyB58,
    allowance,
    note:
      "Mirrors tally_integration/attestation.py verify_attestation + cross_check_allowance. " +
      "The signature proves a card-tap-approved grant; the allowance check proves it is live on-chain at the attested level.",
  });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}

export async function GET() {
  return NextResponse.json(
    {
      endpoint: "POST /api/attest/verify-authority",
      credential:
        'Tally spend-authority attestation (intent): "a human authorized agent A to spend up to X until T"',
      spec: "tally.spend-auth.v1 — see the Tally attestation spec v0.1",
      requestShape: {
        attestation: "spend-authority envelope object, or a JSON string of one",
        expectedIssuer: "optional base58 pubkey pin (the vault that signed)",
        verifyAllowance: "boolean (default true) — cross-check the live on-chain De1egAF allowance",
        cluster: 'optional "devnet" | "mainnet" (default: inferred from payload.mint)',
      },
      companion: "POST /api/attest/verify — the Proof-of-Presence spend-receipt verifier",
    },
    { status: 405 },
  );
}
