import { NextRequest, NextResponse } from "next/server";
import {
  demoRequirement,
  loadFacilitatorKey,
  settleVerified,
  verifyExactPayment,
  X402_VERSION,
} from "@/lib/x402/facilitator";

/**
 * GET /api/x402/demo
 *
 * A live x402-paywalled resource settled by Tally's own facilitator, so an
 * unmodified x402 client can complete a full paid request against us:
 *
 *   1. GET without PAYMENT-SIGNATURE -> 402 + PAYMENT-REQUIRED (base64 accepts[])
 *   2. Client partial-signs the exact/SVM transaction (fee payer = us) and
 *      retries with PAYMENT-SIGNATURE
 *   3. We verify + co-sign + broadcast, then return 200 + PAYMENT-RESPONSE
 *
 * The requirement enforced is OUR canonical one — the client-echoed `accepted`
 * field is never trusted.
 */

const RESOURCE_URL = "https://tally.lll.mk/api/x402/demo";

export async function GET(req: NextRequest) {
  const fac = loadFacilitatorKey();
  if (!fac) {
    return NextResponse.json({ error: "facilitator_not_configured" }, { status: 503 });
  }
  const requirement = demoRequirement(fac, RESOURCE_URL);
  const challenge = {
    x402Version: X402_VERSION,
    error: "payment required",
    accepts: [requirement],
  };
  const challengeB64 = Buffer.from(JSON.stringify(challenge)).toString("base64");

  const header =
    req.headers.get("PAYMENT-SIGNATURE") ?? req.headers.get("X-PAYMENT-SIGNATURE");
  if (!header) {
    return NextResponse.json(challenge, {
      status: 402,
      headers: { "PAYMENT-REQUIRED": challengeB64 },
    });
  }

  let payload: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    payload = null;
  }
  if (!payload) {
    return NextResponse.json(
      { ...challenge, error: "undecodable PAYMENT-SIGNATURE" },
      { status: 402, headers: { "PAYMENT-REQUIRED": challengeB64 } },
    );
  }

  try {
    const verified = await verifyExactPayment(payload, requirement, fac);
    if (!verified.isValid) {
      return NextResponse.json(
        { ...challenge, error: `payment invalid: ${verified.invalidReason}` },
        { status: 402, headers: { "PAYMENT-REQUIRED": challengeB64 } },
      );
    }
    const settled = await settleVerified(verified, requirement, fac);
    if (!settled.success) {
      return NextResponse.json(
        { ...challenge, error: `settlement failed: ${settled.errorReason}` },
        { status: 402, headers: { "PAYMENT-REQUIRED": challengeB64 } },
      );
    }
    const paymentResponse = {
      ok: true,
      txHash: settled.transaction,
      amount: settled.amountAtomic,
      network: requirement.network,
      payer: settled.payer,
    };
    return NextResponse.json(
      {
        ok: true,
        content:
          "Premium content unlocked. This request was paid over x402 (exact/SVM) and settled by Tally's facilitator on Solana devnet.",
        txHash: settled.transaction,
        payer: settled.payer,
        facilitator: fac.publicKeyB58,
      },
      {
        status: 200,
        headers: {
          "PAYMENT-RESPONSE": Buffer.from(JSON.stringify(paymentResponse)).toString("base64"),
        },
      },
    );
  } catch {
    return NextResponse.json({ error: "rpc_error" }, { status: 503 });
  }
}
