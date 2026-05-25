import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv";

/**
 * GET /api/download/{variant}
 *
 * Counted-download endpoint for the public-facing APKs. Increments a Vercel
 * KV counter (best-effort, never blocks the redirect) then 307s to the
 * actual static APK file. The download counter stays private; expose via
 * /api/stats with the STATS_API_KEY env var.
 *
 * The counter is best-effort by design: if KV is down, misconfigured, or
 * unavailable for any reason, the download still works. A failed counter
 * write logs to the function logs but never produces a user-visible error.
 *
 * Variants supported:
 *   - android       → /tally-debug.apk          (real card required)
 *   - android-mock  → /tally-debug-mock-nfc.apk (simulated card tap)
 */

const VARIANTS: Record<string, string> = {
  android: "/tally-debug.apk",
  "android-mock": "/tally-debug-mock-nfc.apk",
};

export const runtime = "nodejs"; // Upstash Redis SDK is Node-compatible

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ variant: string }> },
) {
  // Next.js 15 makes params a Promise; await it.
  const { variant } = await context.params;
  const filePath = VARIANTS[variant];

  if (!filePath) {
    return NextResponse.json(
      { error: "unknown_variant", variant, supported: Object.keys(VARIANTS) },
      { status: 404 },
    );
  }

  // Increment the counter in the background. The fire-and-forget pattern
  // is deliberate: a slow or failing KV must never delay the APK download.
  if (kv) {
    kv.incr(`download:${variant}`).catch((err) => {
      console.warn("[download] KV incr failed:", err);
    });
  }

  // 307 preserves the GET method on the redirect (302 may rewrite to GET on
  // some clients, but the difference is moot for a GET-initiated download).
  return NextResponse.redirect(new URL(filePath, req.url), { status: 307 });
}
