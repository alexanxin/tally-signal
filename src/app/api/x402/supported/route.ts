import { NextResponse } from "next/server";
import { loadFacilitatorKey, X402_VERSION } from "@/lib/x402/facilitator";

/**
 * GET /api/x402/supported
 *
 * Standard x402 facilitator discovery: which (scheme, network) kinds this
 * facilitator can verify and settle. v0: `exact` on solana-devnet.
 */
export async function GET() {
  const fac = loadFacilitatorKey();
  if (!fac) {
    return NextResponse.json(
      { error: "facilitator_not_configured", note: "X402_FACILITATOR_SECRET is not set" },
      { status: 503 },
    );
  }
  return NextResponse.json({
    x402Version: X402_VERSION,
    kinds: [
      {
        scheme: "exact",
        network: "solana-devnet",
        extra: { feePayer: fac.publicKeyB58 },
      },
    ],
    endpoints: {
      verify: "POST /api/x402/verify",
      settle: "POST /api/x402/settle",
      demo: "GET /api/x402/demo (a live 402-paywalled resource settled by this facilitator)",
    },
    operator: "Tally — the human-approval layer for agentic spending on Solana",
    docs: "https://tally.lll.mk/x402.html",
  });
}
