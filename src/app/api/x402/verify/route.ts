import { NextRequest, NextResponse } from "next/server";
import {
  decodePaymentHeader,
  loadFacilitatorKey,
  verifyExactPayment,
  type PaymentRequirement,
} from "@/lib/x402/facilitator";

/**
 * POST /api/x402/verify
 *
 * Standard x402 facilitator verify: is this payment payload valid against
 * these payment requirements? Never signs or broadcasts.
 *
 * Body: {
 *   paymentPayload?: object   — the decoded PAYMENT-SIGNATURE payload, OR
 *   paymentHeader?:  string   — the raw base64 PAYMENT-SIGNATURE header value
 *   paymentRequirements: object — the accepts[] entry being enforced
 * }
 * -> { isValid, invalidReason?, payer? }
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
    return NextResponse.json({ isValid: false, invalidReason: "bad_request_body" }, { status: 400 });
  }
  const payload =
    body.paymentPayload ??
    (body.paymentHeader ? decodePaymentHeader(body.paymentHeader) : null);
  if (!payload) {
    return NextResponse.json(
      { isValid: false, invalidReason: "missing_payment_payload" },
      { status: 400 },
    );
  }
  if (!body.paymentRequirements) {
    return NextResponse.json(
      { isValid: false, invalidReason: "missing_payment_requirements" },
      { status: 400 },
    );
  }
  try {
    const out = await verifyExactPayment(payload, body.paymentRequirements, fac);
    return NextResponse.json({
      isValid: out.isValid,
      ...(out.invalidReason ? { invalidReason: out.invalidReason } : {}),
      ...(out.payer ? { payer: out.payer } : {}),
    });
  } catch {
    return NextResponse.json({ isValid: false, invalidReason: "rpc_error" }, { status: 503 });
  }
}

export async function GET() {
  return NextResponse.json(
    {
      endpoint: "POST /api/x402/verify",
      requestShape: {
        paymentPayload: "decoded PAYMENT-SIGNATURE payload object (or use paymentHeader)",
        paymentHeader: "raw base64 PAYMENT-SIGNATURE header value",
        paymentRequirements: "the accepts[] entry to enforce",
      },
    },
    { status: 405 },
  );
}
