/**
 * Tally spend-authority attestation verification (the intent credential).
 *
 * Shared by the public verifier route (/api/attest/verify-authority) and the
 * x402 facilitator's intent binding, so there is one implementation of the
 * recipe. Mirrors tally_integration/attestation.py (verify_attestation +
 * cross_check_allowance). Spec: documentation/Specs/tally-attestation-spec-v0.1.md
 * (domain tally.spend-auth.v1). Zero external deps: base58 + ed25519 via
 * node:crypto, RPC via fetch.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from "crypto";

export const SPEND_AUTH_DOMAIN = "tally.spend-auth.v1";
export const DELEGATION_PROGRAM = "De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44";
export const USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const MAINNET_RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const DEVNET_RPC = process.env.SOLANA_DEVNET_RPC_URL ?? "https://api.devnet.solana.com";

// FixedDelegation account layout (verified byte-compatible with program v0.4.0;
// V1_LEN = 187 is frozen, later versions only append trailing bytes).
const FD_SIZE = 187;
const FD_OFF_DELEGATOR = 3;
const FD_OFF_DELEGATEE = 35;
const FD_OFF_AMOUNT = 171;
const FD_OFF_EXPIRY = 179;

// ---------------------------------------------------------------------------
// base58 decode (no SDK dep)
// ---------------------------------------------------------------------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX: Record<string, number> = {};
for (let i = 0; i < B58.length; i++) B58_INDEX[B58[i]] = i;

export function base58Decode(s: string): Uint8Array | null {
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
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

// ---------------------------------------------------------------------------
// Ed25519 verify via node:crypto
// ---------------------------------------------------------------------------
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function ed25519Verify(pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  if (pub.length !== 32 || sig.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pub)]),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(null, Buffer.from(msg), key, Buffer.from(sig));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Canonical JSON — byte-identical to Python json.dumps(sort_keys=True,
// separators=(",", ":")) for this payload (flat object, ASCII strings,
// integer numbers). Same recipe the issuers use.
// ---------------------------------------------------------------------------
export function canonicalJson(payload: Record<string, unknown>): string {
  const obj: Record<string, unknown> = {};
  for (const k of Object.keys(payload).sort()) obj[k] = payload[k];
  return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// Types (match attestation.py issue_attestation)
// ---------------------------------------------------------------------------
export interface SpendAuthPayload {
  vault?: string;
  agent?: string;
  mint?: string;
  capAtomic?: number;
  expiryTs?: number;
  delegationPda?: string;
  issuedTs?: number;
}

export interface SpendAuthAttestation {
  alg?: string;
  domain?: string;
  payload?: SpendAuthPayload;
  digest_sha256_hex?: string;
  pubkey_b58?: string;
  signature_b58?: string;
}

export interface AllowanceCheck {
  ok: boolean;
  reason?: string;
  remainingBaseUnits?: string;
  expiryTs?: number;
  cluster?: string;
}

export interface VerifySpendAuthResult {
  valid: boolean;
  reason?: string;
  checks: Record<string, "ok" | "skipped" | "failed">;
  claim?: SpendAuthPayload;
  issuer?: string;
  allowance?: AllowanceCheck;
}

export interface VerifySpendAuthOptions {
  expectedIssuer?: string;
  verifyAllowance?: boolean; // default true
  cluster?: "devnet" | "mainnet"; // default: inferred from payload.mint
}

// ---------------------------------------------------------------------------
// On-chain allowance cross-check (direct account fetch — no getProgramAccounts,
// so it works on any RPC tier)
// ---------------------------------------------------------------------------
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
  // Mirror Python cross_check_allowance: the allowance must still hold at least
  // the attested cap on-chain.
  if (remaining < BigInt(Math.trunc(payload.capAtomic)))
    return { ...base, reason: "allowance_below_attested_cap" };
  return { ...base, ok: true };
}

// ---------------------------------------------------------------------------
// Top-level verify — envelope, digest, issuer pin, ed25519, on-chain allowance
// ---------------------------------------------------------------------------
export async function verifySpendAuthority(
  attestation: SpendAuthAttestation | string,
  opts: VerifySpendAuthOptions = {},
): Promise<VerifySpendAuthResult> {
  const checks: Record<string, "ok" | "skipped" | "failed"> = {
    envelope: "failed",
    digest: "failed",
    issuerMatch: "skipped",
    signature: "failed",
    allowance: "skipped",
  };

  let att: SpendAuthAttestation | null = null;
  if (typeof attestation === "string") {
    try {
      att = JSON.parse(attestation) as SpendAuthAttestation;
    } catch {
      return { valid: false, reason: "bad_attestation_json", checks };
    }
  } else if (attestation && typeof attestation === "object") {
    att = attestation;
  }
  if (!att) return { valid: false, reason: "attestation_required", checks };

  // 1. Envelope
  const payload = att.payload;
  if (!payload || typeof payload !== "object" || att.domain !== SPEND_AUTH_DOMAIN) {
    return { valid: false, reason: "bad_envelope", checks };
  }
  checks.envelope = "ok";

  // 2. Digest recompute
  const digest = createHash("sha256")
    .update(canonicalJson(payload as Record<string, unknown>), "utf8")
    .digest("hex");
  if (digest !== att.digest_sha256_hex) {
    return { valid: false, reason: "digest_mismatch", checks, claim: payload };
  }
  checks.digest = "ok";

  // 3. Optional issuer pin
  const pubkeyB58 = att.pubkey_b58 ?? "";
  if (opts.expectedIssuer) {
    if (pubkeyB58 !== opts.expectedIssuer.trim()) {
      checks.issuerMatch = "failed";
      return { valid: false, reason: "issuer_mismatch", checks, claim: payload };
    }
    checks.issuerMatch = "ok";
  }

  // 4. Ed25519 signature over domain + "\n" + digest
  const pubkeyBytes = base58Decode(pubkeyB58);
  const sigBytes = base58Decode(att.signature_b58 ?? "");
  if (!pubkeyBytes || !sigBytes) {
    return { valid: false, reason: "bad_encoding", checks, claim: payload };
  }
  const message = Buffer.from(`${SPEND_AUTH_DOMAIN}\n${digest}`, "utf8");
  if (!ed25519Verify(pubkeyBytes, message, sigBytes)) {
    return { valid: false, reason: "sig_verify_failed", checks, claim: payload };
  }
  checks.signature = "ok";

  // 5. On-chain allowance cross-check (default true)
  let allowance: AllowanceCheck | undefined;
  if (opts.verifyAllowance !== false) {
    if (!payload.vault || !payload.agent || !payload.delegationPda || payload.capAtomic === undefined) {
      checks.allowance = "failed";
      return { valid: false, reason: "payload_missing_allowance_fields", checks, claim: payload };
    }
    const cluster = opts.cluster ?? (payload.mint === USDC_MINT_DEVNET ? "devnet" : "mainnet");
    const rpcUrl = cluster === "devnet" ? DEVNET_RPC : MAINNET_RPC;
    try {
      allowance = await crossCheckAllowance(
        payload as Parameters<typeof crossCheckAllowance>[0],
        rpcUrl,
        cluster,
      );
    } catch {
      checks.allowance = "failed";
      return { valid: false, reason: "rpc_error", checks, claim: payload };
    }
    if (!allowance.ok) {
      checks.allowance = "failed";
      return { valid: false, reason: allowance.reason ?? "allowance_failed", checks, claim: payload, issuer: pubkeyB58, allowance };
    }
    checks.allowance = "ok";
  }

  return { valid: true, checks, claim: payload, issuer: pubkeyB58, allowance };
}
