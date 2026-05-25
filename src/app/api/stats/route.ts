import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv";

/**
 * GET /api/stats?key=<STATS_API_KEY>
 *
 * Private operator endpoint. Returns the current download counts plus a
 * timestamp for caching. Gated by a single shared secret in the
 * STATS_API_KEY env var. Returns 503 if neither the key env var nor KV
 * are configured, so the endpoint stays invisible to drive-by traffic.
 *
 * Not a public dashboard. The counts intentionally stay off start.html
 * (small numbers early on read as weak signal; once volume justifies it
 * we can revisit displaying a "X downloads" badge).
 */

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const expected = process.env.STATS_API_KEY;

  if (!expected) {
    // Don't leak that the endpoint exists when no key is configured.
    return NextResponse.json(
      { error: "service_unavailable" },
      { status: 503 },
    );
  }

  const provided = req.nextUrl.searchParams.get("key");
  if (provided !== expected) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401 },
    );
  }

  if (!kv) {
    return NextResponse.json(
      { error: "kv_not_configured" },
      { status: 503 },
    );
  }

  const [android, androidMock] = await Promise.all([
    kv.get<number>("download:android"),
    kv.get<number>("download:android-mock"),
  ]);

  const a = android ?? 0;
  const m = androidMock ?? 0;

  return NextResponse.json(
    {
      downloads: {
        android: a,
        androidMock: m,
        total: a + m,
      },
      generatedAt: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
