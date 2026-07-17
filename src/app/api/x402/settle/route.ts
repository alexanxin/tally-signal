import { NextRequest, NextResponse } from "next/server";
import {
  decodePaymentHeader,
  loadFacilitatorKey,
  settleVerified,
  verifyExactPayment,
  type PaymentRequirement,
} from "@/lib/x402/facilitator";

/**
 * POST /api/x402/settle
 *
 * Standard x402 facilitator settle: re-verify, then co-sign the fee-payer slot
 * and broadcast. We NEVER sign a transaction that did not pass the full verify.
 *
 * Body: same shape as /api/x402/verify.
 * -> { success, errorReason?, transaction?, network?, payer? }
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
  try {
    const verified = await verifyExactPayment(payload, body.paymentRequirements, fac);
    if (!verified.isValid) {
      return NextResponse.json({
        success: false,
        errorReason: verified.invalidReason ?? "verification_failed",
      });
    }
    const settled = await settleVerified(verified, body.paymentRequirements, fac);
    return NextResponse.json(settled);
  } catch {
    return NextResponse.json({ success: false, errorReason: "rpc_error" }, { status: 503 });
  }
}

export async function GET() {
  return NextResponse.json(
    {
      endpoint: "POST /api/x402/settle",
      requestShape: "same as POST /api/x402/verify; settles only if verification passes",
    },
    { status: 405 },
  );
}
