import { NextRequest, NextResponse } from "next/server";
import {
  verifySpendAuthority,
  SPEND_AUTH_DOMAIN,
  type SpendAuthAttestation,
} from "@/lib/attest/spend-authority";

/**
 * POST /api/attest/verify-authority
 *
 * Public verifier for the Tally spend-authority attestation, the INTENT
 * credential: "human H authorized agent A to spend up to X of asset M until T,
 * enforced by delegation PDA D." Spec: documentation/Specs/
 * tally-attestation-spec-v0.1.md (domain tally.spend-auth.v1).
 *
 * The verification recipe lives in @/lib/attest/spend-authority so the x402
 * facilitator's intent binding uses the exact same implementation:
 *   1. envelope: payload is an object, domain == "tally.spend-auth.v1"
 *   2. digest:   sha256(canonical_json(payload)).hex == digest_sha256_hex
 *   3. issuer:   optional pin, pubkey_b58 == expectedIssuer
 *   4. sig:      ed25519_verify(signature_b58, pubkey_b58, domain + "\n" + digest)
 *   5. allowance (the on-chain half; the signature is never trusted alone):
 *      the delegationPda is a live De1egAF FixedDelegation with delegator == vault,
 *      delegatee == agent, expiryTs > now, and remaining >= capAtomic.
 *
 * The companion endpoint /api/attest/verify checks the Proof-of-Presence spend
 * RECEIPT (a payment happened); this one checks the spend AUTHORITY (a human
 * granted it). Together they close the chain: human approval, bounded authority,
 * settled draw.
 */
interface VerifyAuthorityRequest {
  attestation: SpendAuthAttestation | string;
  expectedIssuer?: string;
  verifyAllowance?: boolean; // default true
  cluster?: "devnet" | "mainnet"; // default: inferred from payload.mint
}

export async function POST(req: NextRequest) {
  let body: VerifyAuthorityRequest;
  try {
    body = (await req.json()) as VerifyAuthorityRequest;
  } catch {
    return NextResponse.json({ valid: false, reason: "bad_request_body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || body.attestation == null) {
    return NextResponse.json({ valid: false, reason: "bad_request_body" }, { status: 400 });
  }

  const r = await verifySpendAuthority(body.attestation, {
    expectedIssuer: body.expectedIssuer,
    verifyAllowance: body.verifyAllowance,
    cluster: body.cluster,
  });

  const status =
    r.reason === "bad_attestation_json" || r.reason === "attestation_required"
      ? 400
      : r.reason === "rpc_error"
        ? 503
        : 200;

  return NextResponse.json(
    {
      valid: r.valid,
      ...(r.reason ? { reason: r.reason } : {}),
      checks: r.checks,
      ...(r.claim ? { payload: r.claim } : {}),
      ...(r.issuer ? { issuer: r.issuer } : {}),
      ...(r.allowance ? { allowance: r.allowance } : {}),
      ...(r.valid
        ? {
            note:
              "Mirrors tally_integration/attestation.py verify_attestation + cross_check_allowance. " +
              "The signature proves a card-tap-approved grant; the allowance check proves it is live on-chain at the attested level.",
          }
        : {}),
    },
    { status },
  );
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
      spec: `${SPEND_AUTH_DOMAIN}, see the Tally attestation spec v0.1`,
      requestShape: {
        attestation: "spend-authority envelope object, or a JSON string of one",
        expectedIssuer: "optional base58 pubkey pin (the vault that signed)",
        verifyAllowance: "boolean (default true), cross-check the live on-chain De1egAF allowance",
        cluster: 'optional "devnet" | "mainnet" (default: inferred from payload.mint)',
      },
      companion: "POST /api/attest/verify, the Proof-of-Presence spend-receipt verifier",
    },
    { status: 405 },
  );
}
