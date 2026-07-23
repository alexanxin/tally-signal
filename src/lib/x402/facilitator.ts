/**
 * Tally x402 facilitator v0 — the `exact`/SVM scheme on devnet.
 *
 * Verifies a partial-signed x402 payment transaction and co-signs the fee-payer
 * slot, then broadcasts. Port of the proven Python reference
 * (warm-vault/tally_integration/facilitator/upto_facilitator.py) narrowed to the
 * standard `exact` scheme; wire format pinned by x402_std.py, which completed
 * live paid requests against the PayAI devnet facilitator (x402 v2).
 *
 * Security model (same trust boundary as the reference): co-signing someone
 * else's transaction is the risk. We only co-sign a transaction that contains
 * EXACTLY {optional ComputeBudget limit/price, optional createAtaIdempotent for
 * payTo, one SPL TransferChecked of the required amount to payTo's ATA}, whose
 * fee payer is us, and whose payer signature is cryptographically valid. The
 * dest ATA is confirmed on-chain to belong to payTo before signing.
 *
 * Zero external deps: base58 + shortvec + Ed25519 via node:crypto, RPC via fetch.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  KeyObject,
} from "crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export const X402_VERSION = 2;
export const USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const DEVNET_RPC =
  process.env.SOLANA_DEVNET_RPC_URL ?? "https://api.devnet.solana.com";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

const MAX_COMPUTE_UNIT_LIMIT = 200_000; // a checked transfer needs ~5k CU
const MAX_COMPUTE_UNIT_PRICE = 5_000_000; // micro-lamports, bounds our gas cost

// ---------------------------------------------------------------------------
// base58 (decode + encode, no SDK dep)
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

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

// ---------------------------------------------------------------------------
// Ed25519 via node:crypto
// ---------------------------------------------------------------------------
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function ed25519Verify(pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  if (pub.length !== 32 || sig.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(pub)]),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(null, Buffer.from(msg), key, Buffer.from(sig));
  } catch {
    return false;
  }
}

export interface FacilitatorKey {
  privateKey: KeyObject;
  publicKeyBytes: Uint8Array;
  publicKeyB58: string;
}

/** Load the facilitator keypair from a urlsafe-base64 32-byte seed (the same
 * format tally_integration uses for TALLY_FACILITATOR_SK). */
export function loadFacilitatorKey(envValue?: string): FacilitatorKey | null {
  const raw = (envValue ?? process.env.X402_FACILITATOR_SECRET ?? "").trim();
  if (!raw) return null;
  let seed: Buffer;
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    seed = Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64").subarray(0, 32);
  } catch {
    return null;
  }
  if (seed.length !== 32) return null;
  try {
    const privateKey = createPrivateKey({
      key: Buffer.concat([PKCS8_PREFIX, seed]),
      format: "der",
      type: "pkcs8",
    });
    const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
    const publicKeyBytes = new Uint8Array(spki.subarray(spki.length - 32));
    return { privateKey, publicKeyBytes, publicKeyB58: base58Encode(publicKeyBytes) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transaction parsing (legacy + v0, shortvec encoding)
// ---------------------------------------------------------------------------
interface ParsedInstruction {
  programId: string;
  accounts: string[]; // resolved base58 keys
  data: Buffer;
}

export interface ParsedTx {
  raw: Buffer;
  signatures: Buffer[]; // 64 bytes each
  sigSectionLen: number; // offset where the message starts
  messageBytes: Buffer;
  numRequiredSignatures: number;
  accountKeys: string[]; // base58
  instructions: ParsedInstruction[];
}

function readShortVec(buf: Buffer, o: number): [number, number] {
  let len = 0;
  let size = 0;
  for (;;) {
    if (o + size >= buf.length + 1 && size > 0) throw new Error("shortvec overrun");
    const b = buf[o + size];
    len |= (b & 0x7f) << (size * 7);
    size++;
    if ((b & 0x80) === 0) break;
    if (size > 3) throw new Error("shortvec too long");
  }
  return [len, o + size];
}

export function parseTransaction(txBytes: Buffer): ParsedTx {
  let o = 0;
  const [nSigs, o1] = readShortVec(txBytes, o);
  o = o1;
  const signatures: Buffer[] = [];
  for (let i = 0; i < nSigs; i++) {
    signatures.push(txBytes.subarray(o, o + 64));
    o += 64;
  }
  const sigSectionLen = o;
  const messageBytes = txBytes.subarray(o);

  let m = 0;
  const first = messageBytes[m];
  let version = -1; // legacy
  if (first & 0x80) {
    version = first & 0x7f;
    if (version !== 0) throw new Error(`unsupported tx version ${version}`);
    m += 1;
  }
  const numRequiredSignatures = messageBytes[m];
  m += 3; // header: requiredSigs, readonlySigned, readonlyUnsigned
  const [nKeys, m1] = readShortVec(messageBytes, m);
  m = m1;
  const accountKeys: string[] = [];
  for (let i = 0; i < nKeys; i++) {
    accountKeys.push(base58Encode(new Uint8Array(messageBytes.subarray(m, m + 32))));
    m += 32;
  }
  m += 32; // recent blockhash
  const [nIx, m2] = readShortVec(messageBytes, m);
  m = m2;
  const instructions: ParsedInstruction[] = [];
  for (let i = 0; i < nIx; i++) {
    const programIdIndex = messageBytes[m];
    m += 1;
    const [nAcc, ma] = readShortVec(messageBytes, m);
    m = ma;
    const accounts: string[] = [];
    for (let j = 0; j < nAcc; j++) {
      accounts.push(accountKeys[messageBytes[m]]);
      m += 1;
    }
    const [nData, md] = readShortVec(messageBytes, m);
    m = md;
    instructions.push({
      programId: accountKeys[programIdIndex],
      accounts,
      data: Buffer.from(messageBytes.subarray(m, m + nData)),
    });
    m += nData;
  }
  if (version === 0) {
    const [nLookups] = readShortVec(messageBytes, m);
    if (nLookups !== 0) throw new Error("address table lookups not supported");
  }
  return {
    raw: txBytes,
    signatures,
    sigSectionLen,
    messageBytes: Buffer.from(messageBytes),
    numRequiredSignatures,
    accountKeys,
    instructions,
  };
}

// ---------------------------------------------------------------------------
// Requirement + payment envelope (x402 v2, pinned by x402_std.py)
// ---------------------------------------------------------------------------
export interface PaymentRequirement {
  scheme?: string;
  network?: string;
  amount?: string | number;
  maxAmountRequired?: string | number;
  asset?: string | { address?: string };
  payTo?: string;
  resource?: string;
  description?: string;
  extra?: { feePayer?: string; resource?: string; description?: string; [k: string]: unknown };
}

export function requirementAsset(req: PaymentRequirement): string {
  const a = req.asset;
  return (typeof a === "object" && a ? a.address : a) ?? "";
}

export function requirementAmount(req: PaymentRequirement): number {
  const v = req.amount ?? req.maxAmountRequired ?? "0";
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Decode a PAYMENT-SIGNATURE header (base64 JSON PaymentPayload). */
export function decodePaymentHeader(headerB64: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(headerB64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------
export interface VerifyOutcome {
  isValid: boolean;
  invalidReason?: string;
  payer?: string; // the transfer authority (agent/session key)
  amountAtomic?: number;
  tx?: ParsedTx;
}

async function getAtaInfo(
  ata: string,
  rpcUrl: string,
): Promise<{ owner: string; mint: string } | null> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [ata, { encoding: "jsonParsed", commitment: "confirmed" }],
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`rpc_http_${res.status}`);
  const data = (await res.json()) as {
    result?: { value?: { data?: { parsed?: { info?: { owner?: string; mint?: string } } } } };
  };
  const info = data?.result?.value?.data?.parsed?.info;
  if (!info?.owner || !info?.mint) return null;
  return { owner: info.owner, mint: info.mint };
}

/** Verify an `exact`/SVM payment against a requirement. Never signs anything. */
export async function verifyExactPayment(
  paymentPayload: Record<string, unknown>,
  req: PaymentRequirement,
  facilitator: FacilitatorKey,
  rpcUrl: string = DEVNET_RPC,
): Promise<VerifyOutcome> {
  // Envelope
  const version = paymentPayload["x402Version"];
  if (version !== X402_VERSION) return { isValid: false, invalidReason: "unsupported_x402_version" };
  const inner = paymentPayload["payload"] as { transaction?: string } | undefined;
  const txB64 = inner?.transaction;
  if (!txB64 || typeof txB64 !== "string")
    return { isValid: false, invalidReason: "missing_transaction" };

  // Requirement
  if (req.scheme !== "exact") return { isValid: false, invalidReason: "unsupported_scheme" };
  if (!String(req.network ?? "").startsWith("solana"))
    return { isValid: false, invalidReason: "unsupported_network" };
  const asset = requirementAsset(req);
  if (asset !== USDC_MINT_DEVNET)
    return { isValid: false, invalidReason: "asset_not_supported_v0_devnet_usdc_only" };
  const amount = requirementAmount(req);
  if (amount <= 0) return { isValid: false, invalidReason: "bad_amount" };
  const payTo = req.payTo ?? "";
  if (!payTo) return { isValid: false, invalidReason: "missing_payTo" };
  const feePayer = req.extra?.feePayer ?? facilitator.publicKeyB58;
  if (feePayer !== facilitator.publicKeyB58)
    return { isValid: false, invalidReason: "fee_payer_not_this_facilitator" };

  // Transaction structure
  let tx: ParsedTx;
  try {
    tx = parseTransaction(Buffer.from(txB64, "base64"));
  } catch (e) {
    return { isValid: false, invalidReason: `undecodable_transaction: ${String((e as Error).message)}` };
  }
  if (tx.accountKeys[0] !== facilitator.publicKeyB58)
    return { isValid: false, invalidReason: "fee_payer_slot_not_facilitator" };

  // Instruction allowlist
  let transfer: ParsedInstruction | null = null;
  let createdPayToAta: string | null = null; // payTo's ATA created in-tx (createAtaIdempotent)
  for (const ix of tx.instructions) {
    if (ix.programId === COMPUTE_BUDGET_PROGRAM) {
      const disc = ix.data[0];
      if (disc === 2) {
        if (ix.data.length < 5 || ix.data.readUInt32LE(1) > MAX_COMPUTE_UNIT_LIMIT)
          return { isValid: false, invalidReason: "compute_unit_limit_too_high" };
      } else if (disc === 3) {
        if (ix.data.length < 9 || ix.data.readBigUInt64LE(1) > BigInt(MAX_COMPUTE_UNIT_PRICE))
          return { isValid: false, invalidReason: "compute_unit_price_too_high" };
      } else {
        return { isValid: false, invalidReason: "disallowed_compute_budget_ix" };
      }
      continue;
    }
    if (ix.programId === ATA_PROGRAM) {
      // createAtaIdempotent for payTo only: accounts = [payer, ata, owner, mint, ...]
      if (!(ix.data.length === 0 || (ix.data.length === 1 && ix.data[0] === 1)))
        return { isValid: false, invalidReason: "disallowed_ata_ix" };
      if (ix.accounts.length < 4 || ix.accounts[2] !== payTo)
        return { isValid: false, invalidReason: "ata_create_not_for_payTo" };
      // Remember payTo's canonical ATA when it is created in this tx for the
      // asset. The ATA program enforces canonicity on execution.
      if (ix.accounts[3] === asset) createdPayToAta = ix.accounts[1];
      continue;
    }
    if (ix.programId === TOKEN_PROGRAM) {
      if (ix.data[0] !== 12) return { isValid: false, invalidReason: "token_ix_not_transferChecked" };
      if (transfer) return { isValid: false, invalidReason: "multiple_transfers" };
      if (ix.data.length !== 10) return { isValid: false, invalidReason: "malformed_transferChecked" };
      transfer = ix;
      continue;
    }
    return { isValid: false, invalidReason: `disallowed_instruction_program_${ix.programId}` };
  }
  if (!transfer) return { isValid: false, invalidReason: "no_transfer_instruction" };

  // TransferChecked: [src_ata, mint, dest_ata, owner]; data = 12 | u64 amount | u8 decimals
  const drawn = Number(transfer.data.readBigUInt64LE(1));
  if (drawn !== amount) return { isValid: false, invalidReason: "amount_mismatch" };
  const [, ixMint, destAta, owner] = transfer.accounts;
  if (ixMint !== asset) return { isValid: false, invalidReason: "wrong_mint" };
  if (transfer.accounts.length < 4 || !owner)
    return { isValid: false, invalidReason: "malformed_transfer_accounts" };

  // The payer (transfer authority) must be a required signer with a VALID signature.
  const ownerIdx = tx.accountKeys.indexOf(owner);
  if (ownerIdx < 0 || ownerIdx >= tx.numRequiredSignatures)
    return { isValid: false, invalidReason: "payer_not_a_signer" };
  const ownerSig = tx.signatures[ownerIdx];
  if (!ownerSig || ownerSig.every((b) => b === 0))
    return { isValid: false, invalidReason: "payer_did_not_sign" };
  const ownerPub = base58Decode(owner);
  if (!ownerPub || !ed25519Verify(ownerPub, tx.messageBytes, ownerSig))
    return { isValid: false, invalidReason: "payer_signature_invalid" };

  // Destination must be payTo's canonical ATA for the asset. Either it already
  // exists on-chain (confirm owner + mint), or this tx creates it via a
  // createAtaIdempotent for payTo (the ATA program enforces canonicity on
  // execution, so a wrong-owner or non-canonical ata simply makes the tx fail).
  if (createdPayToAta !== destAta) {
    const ataInfo = await getAtaInfo(destAta, rpcUrl);
    if (!ataInfo) return { isValid: false, invalidReason: "destination_ata_not_found" };
    if (ataInfo.mint !== asset) return { isValid: false, invalidReason: "destination_wrong_mint" };
    if (ataInfo.owner !== payTo) return { isValid: false, invalidReason: "destination_not_payTo" };
  }

  return { isValid: true, payer: owner, amountAtomic: drawn, tx };
}

// ---------------------------------------------------------------------------
// Settle
// ---------------------------------------------------------------------------
export interface SettleOutcome {
  success: boolean;
  errorReason?: string;
  transaction?: string; // base58 tx signature
  network?: string;
  payer?: string;
  amountAtomic?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Co-sign the fee-payer slot and broadcast. Call ONLY with a verified tx. */
export async function settleVerified(
  outcome: VerifyOutcome,
  req: PaymentRequirement,
  facilitator: FacilitatorKey,
  rpcUrl: string = DEVNET_RPC,
): Promise<SettleOutcome> {
  if (!outcome.isValid || !outcome.tx)
    return { success: false, errorReason: outcome.invalidReason ?? "not_verified" };
  const tx = outcome.tx;

  const facSig = cryptoSign(null, tx.messageBytes, facilitator.privateKey);
  const signed = Buffer.from(tx.raw); // copy, then overwrite fee-payer sig slot 0
  facSig.copy(signed, tx.sigSectionLen - tx.signatures.length * 64);

  const send = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [
        signed.toString("base64"),
        { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 },
      ],
    }),
    cache: "no-store",
  });
  const sendBody = (await send.json()) as {
    result?: string;
    error?: { code?: number; message?: string };
  };
  if (!sendBody.result) {
    return {
      success: false,
      errorReason: `send_failed: ${sendBody.error?.message ?? "unknown"}`,
    };
  }
  const sig = sendBody.result;

  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const st = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignatureStatuses",
        params: [[sig], { searchTransactionHistory: false }],
      }),
      cache: "no-store",
    });
    const stBody = (await st.json()) as {
      result?: { value?: Array<{ confirmationStatus?: string; err?: unknown } | null> };
    };
    const s = stBody?.result?.value?.[0];
    if (s) {
      if (s.err) return { success: false, errorReason: `tx_failed_on_chain: ${JSON.stringify(s.err)}`, transaction: sig };
      if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") {
        return {
          success: true,
          transaction: sig,
          network: req.network,
          payer: outcome.payer,
          amountAtomic: outcome.amountAtomic,
        };
      }
    }
  }
  return { success: false, errorReason: "confirmation_timeout", transaction: sig };
}

// ---------------------------------------------------------------------------
// The demo merchant's canonical requirement
// ---------------------------------------------------------------------------
export function demoRequirement(facilitator: FacilitatorKey, resourceUrl: string): PaymentRequirement {
  const payTo = process.env.X402_DEMO_PAY_TO?.trim() || facilitator.publicKeyB58;
  return {
    scheme: "exact",
    network: "solana-devnet",
    amount: "10000", // 0.01 USDC
    asset: USDC_MINT_DEVNET,
    payTo,
    resource: resourceUrl,
    description: "Tally x402 facilitator demo — 0.01 devnet USDC for premium content",
    extra: {
      feePayer: facilitator.publicKeyB58,
      resource: resourceUrl,
      description: "Tally x402 facilitator demo — 0.01 devnet USDC for premium content",
    },
  };
}

/** sha256 hex, used for response integrity notes. */
export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
