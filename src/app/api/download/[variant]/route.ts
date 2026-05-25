import { NextRequest, NextResponse, after } from "next/server";
import nodemailer from "nodemailer";
import { kv } from "@/lib/kv";

/**
 * GET /api/download/{variant}
 *
 * Counted-download endpoint for the public-facing APKs. Increments a Vercel
 * KV counter and (optionally) emails the operator after the response is sent,
 * then 307s to the actual static APK file. Counter + email run inside an
 * `after()` block so the redirect is returned immediately and nothing the
 * server does post-response can delay the user.
 *
 * Variants supported:
 *   - android       → /tally-debug.apk          (real card required)
 *   - android-mock  → /tally-debug-mock-nfc.apk (simulated card tap)
 *
 * Counter is best-effort: if KV is down, misconfigured, or unavailable for
 * any reason, the download still works. A failed counter write logs to the
 * function logs but never produces a user-visible error.
 *
 * Email notification is opt-in via env var `DOWNLOAD_EMAIL_NOTIFY=true`.
 * Default is off. When on, every download triggers an email to
 * WAITLIST_TO_EMAIL (defaults to aleksandar@lll.mk) with the running count
 * in the subject line so the inbox sorts naturally. Reuses the same SMTP
 * env vars the waitlist route uses (EMAIL_SERVER_HOST/PORT/USER/PASSWORD,
 * EMAIL_FROM).
 *
 * Once downloads exceed ~20/day, per-download email becomes noise. At that
 * point flip DOWNLOAD_EMAIL_NOTIFY off and switch to a daily-digest cron
 * (out of scope for this iteration).
 */

const VARIANTS: Record<string, string> = {
  android: "/tally-debug.apk",
  "android-mock": "/tally-debug-mock-nfc.apk",
};

const VARIANT_LABELS: Record<string, string> = {
  android: "Android (real card)",
  "android-mock": "Android (mock NFC)",
};

export const runtime = "nodejs"; // Upstash Redis SDK + nodemailer are Node-only

function smtpConfigured(): boolean {
  return Boolean(
    process.env.EMAIL_SERVER_HOST &&
      process.env.EMAIL_SERVER_PORT &&
      process.env.EMAIL_SERVER_USER &&
      process.env.EMAIL_SERVER_PASSWORD &&
      process.env.EMAIL_FROM,
  );
}

function buildNotificationHtml(args: {
  variant: string;
  count: number | null;
  userAgent: string;
  ip: string;
  referer: string;
}): string {
  const { variant, count, userAgent, ip, referer } = args;
  const label = VARIANT_LABELS[variant] ?? variant;
  const ts = new Date().toISOString();
  const countLine =
    count === null
      ? `<em style="color:#9aa3ad;">unavailable (KV write failed)</em>`
      : `<strong style="color:#4ade80;">#${count}</strong>`;
  return `
    <div style="font-family: 'Inter', -apple-system, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; background: #0b0f14; color: #e5e5e5;">
      <div style="font-family: monospace; font-size: 11px; color: #4ade80; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 18px;">
        &gt; Tally Download
      </div>
      <div style="background: #111820; padding: 18px; border: 1px solid #1f2a36;">
        <p style="margin: 0 0 12px 0;">
          <strong style="color: #4ade80; font-family: monospace; font-size: 12px; letter-spacing: 1px;">VARIANT</strong><br>
          <span style="color: #ffffff; font-family: monospace;">${label}</span>
        </p>
        <p style="margin: 0 0 12px 0;">
          <strong style="color: #4ade80; font-family: monospace; font-size: 12px; letter-spacing: 1px;">COUNT</strong><br>
          <span style="color: #ffffff; font-family: monospace;">${countLine}</span>
        </p>
        <p style="margin: 0 0 12px 0;">
          <strong style="color: #4ade80; font-family: monospace; font-size: 12px; letter-spacing: 1px;">IP</strong><br>
          <span style="color: #c7cdd4; font-family: monospace; font-size: 12px;">${ip}</span>
        </p>
        <p style="margin: 0 0 12px 0;">
          <strong style="color: #4ade80; font-family: monospace; font-size: 12px; letter-spacing: 1px;">USER AGENT</strong><br>
          <span style="color: #c7cdd4; font-family: monospace; font-size: 11px; word-break: break-all;">${userAgent}</span>
        </p>
        ${referer && referer !== "unknown" ? `
        <p style="margin: 0 0 12px 0;">
          <strong style="color: #4ade80; font-family: monospace; font-size: 12px; letter-spacing: 1px;">REFERER</strong><br>
          <span style="color: #c7cdd4; font-family: monospace; font-size: 11px; word-break: break-all;">${referer}</span>
        </p>` : ""}
        <p style="margin: 0; color: #6b7280; font-family: monospace; font-size: 10px;">
          <strong style="color: #4ade80;">AT</strong> ${ts}
        </p>
      </div>
      <p style="color: #6b7280; font-size: 10px; margin-top: 16px; font-family: monospace;">
        Disable per-download emails by removing or unsetting DOWNLOAD_EMAIL_NOTIFY in Vercel env.
      </p>
    </div>
  `.trim();
}

async function sendDownloadNotification(args: {
  variant: string;
  count: number | null;
  userAgent: string;
  ip: string;
  referer: string;
}) {
  const port = Number(process.env.EMAIL_SERVER_PORT!);
  const secure =
    process.env.EMAIL_SERVER_SECURE === "true" || port === 465;

  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_SERVER_HOST!,
    port,
    secure,
    auth: {
      user: process.env.EMAIL_SERVER_USER!,
      pass: process.env.EMAIL_SERVER_PASSWORD!,
    },
  });

  const label = VARIANT_LABELS[args.variant] ?? args.variant;
  const subject =
    args.count === null
      ? `[Tally] Download (${label})`
      : `[Tally] Download #${args.count} (${label})`;

  await transporter.sendMail({
    from: process.env.EMAIL_FROM!,
    to: process.env.WAITLIST_TO_EMAIL ?? "aleksandar@lll.mk",
    subject,
    html: buildNotificationHtml(args),
  });
}

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

  // Capture request context BEFORE entering after() — the request object's
  // headers may not be readable post-response.
  const userAgent = req.headers.get("user-agent") ?? "unknown";
  const forwarded = req.headers.get("x-forwarded-for");
  const ip =
    (forwarded ? forwarded.split(",")[0]?.trim() : null) ??
    req.headers.get("x-real-ip") ??
    "unknown";
  const referer = req.headers.get("referer") ?? "unknown";

  // Post-response work: counter + optional notification email. Using
  // Next.js 15's `after()` so the redirect goes out immediately and neither
  // KV nor SMTP latency can delay the download.
  after(async () => {
    let count: number | null = null;
    if (kv) {
      try {
        count = await kv.incr(`download:${variant}`);
      } catch (err) {
        console.warn("[download] KV incr failed:", err);
      }
    }

    if (process.env.DOWNLOAD_EMAIL_NOTIFY !== "true") return;
    if (!smtpConfigured()) {
      console.warn(
        "[download] DOWNLOAD_EMAIL_NOTIFY=true but SMTP env vars missing; skipping email",
      );
      return;
    }

    try {
      await sendDownloadNotification({ variant, count, userAgent, ip, referer });
    } catch (err) {
      const e = err as { message?: string; code?: string };
      console.warn("[download] notification email failed:", {
        message: e?.message,
        code: e?.code,
        variant,
      });
    }
  });

  // 307 preserves the GET method on the redirect (302 may rewrite to GET on
  // some clients, but the difference is moot for a GET-initiated download).
  return NextResponse.redirect(new URL(filePath, req.url), { status: 307 });
}
