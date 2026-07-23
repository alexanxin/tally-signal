import { NextRequest, NextResponse } from "next/server";
import {
  decodePaymentHeader,
  loadFacilitatorKey,
  settleVerified,
  verifyExactPayment,
  type PaymentRequirement,
} from "@/lib/x402/facilitator";
import { bindSpendAuthority, type IntentBinding } from "@/lib/x402/intent-binding";
import { type SpendAuthAttestation } from "@/lib/attest/spend-authority";

/**
 * POST /api/x402/settle
 *
 * Standard x402 facilitator settle: re-verify, then co-sign the fee-payer slot
 * and broadcast. We NEVER sign a transaction that did not pass the full verify.
 *
 * Intent-hub extension (optional, backward compatible): if the request includes
 * `spendAuthorityAttestation`, the facilitator binds it to this payment (the
 * human-approved agent must be the payer, and the amount within the authorized
 * cap) and returns the verified `binding` alongside the settlement. If the
 * requirement's `extra.requireHumanApproval` is true, the facilitator refuses to
 * settle without a valid binding.
 *
 * Body: { paymentPayload | paymentHeader, paymentRequirements, spendAuthorityAttestation? }
 * -> { success, errorReason?, transaction?, network?, payer?, binding? }
 */
export async function POST(req: NextRequest) {
  const fac = loadFacilitatorKey();
  if (!fac) {
    return NextResponse.json({ error: "facilitator_not_configured" }, { status: 503 });
  }
  let body: {
    paymentPayload?: Record<string, unknown>;
    paymentHeader?: string;
    paymentRequirements?: PaymentRequirement;
    spendAuthorityAttestation?: SpendAuthAttestation | string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, errorReason: "bad_request_body" }, { status: 400 });
  }
  const payload =
    body.paymentPayload ??
    (body.paymentHeader ? decodePaymentHeader(body.paymentHeader) : null);
  if (!payload || !body.paymentRequirements) {
    return NextResponse.json(
      { success: false, errorReason: "missing_payload_or_requirements" },
      { status: 400 },
    );
  }
  const requirement = body.paymentRequirements;
  try {
    const verified = await verifyExactPayment(payload, requirement, fac);
    if (!verified.isValid) {
      return NextResponse.json({
        success: false,
        errorReason: verified.invalidReason ?? "verification_failed",
      });
    }

    // Intent binding (the hub layer). If the agent presents a spend-authority
    // attestation, verify it and bind it to this payment before settling.
    let binding: IntentBinding | undefined;
    if (body.spendAuthorityAttestation != null) {
      const cluster = String(requirement.network ?? "").includes("devnet") ? "devnet" : "mainnet";
      binding = await bindSpendAuthority(verified, body.spendAuthorityAttestation, cluster);
    }
    const requireHumanApproval = requirement.extra?.requireHumanApproval === true;
    if (requireHumanApproval && !binding?.bound) {
      // The resource requires human approval, and we do not have a valid one.
      // Refuse to settle.
      return NextResponse.json({
        success: false,
        errorReason: "human_approval_required",
        ...(binding ? { binding } : {}),
      });
    }

    const settled = await settleVerified(verified, requirement, fac);
    return NextResponse.json({ ...settled, ...(binding ? { binding } : {}) });
  } catch {
    return NextResponse.json({ success: false, errorReason: "rpc_error" }, { status: 503 });
  }
}

export async function GET() {
  return NextResponse.json(
    {
      endpoint: "POST /api/x402/settle",
      requestShape: "same as POST /api/x402/verify, plus optional spendAuthorityAttestation",
      intentBinding:
        "if spendAuthorityAttestation is present, the response includes a verified binding " +
        "(human approval bound to the settled draw); extra.requireHumanApproval=true refuses to settle without it",
    },
    { status: 405 },
  );
}
