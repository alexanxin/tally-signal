import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";

/**
 * POST /api/waitlist
 *
 * Tiny "join the waitlist" endpoint backing the form in the start.html
 * footer CTA. Stateless by design: no database, no dedup, no analytics.
 * Each valid submission triggers two emails: a notification to the operator
 * inbox (required, blocks the response on failure) and a welcome to the
 * signup (best-effort, never blocks the response).
 *
 * Tradeoff: duplicates just stack in the inbox. Acceptable while the volume
 * is small. Swap in a Vercel KV dedup if it gets noisy.
 *
 * Tradeoff #2: sending TO an arbitrary address creates a (small) spam
 * vector — someone enters an enemy's email, our server sends them a
 * welcome. Honeypot + email regex are the only filters; volume is capped
 * by Vercel + Resend rate limits. Add proper IP-based throttling via
 * Vercel KV if it gets abused.
 *
 * Env vars (set in Vercel for tally-signal; same names as the lll.mk
 * contact form so a single set of SMTP credentials works for both projects):
 *
 *   EMAIL_SERVER_HOST       SMTP host (e.g. smtp.fastmail.com)
 *   EMAIL_SERVER_PORT       SMTP port (e.g. 587)
 *   EMAIL_SERVER_USER       SMTP user
 *   EMAIL_SERVER_PASSWORD   SMTP password / app-specific password
 *   EMAIL_FROM              From address (e.g. "Tally Waitlist <hello@lll.mk>")
 *   WAITLIST_TO_EMAIL       Destination inbox (defaults to aleksandar@lll.mk)
 *   EMAIL_SERVER_SECURE     "true" forces TLS. Defaults to true for port 465,
 *                           false otherwise (STARTTLS on 587).
 *   WAITLIST_DEBUG          "1" surfaces the nodemailer error message back
 *                           to the client in the response body for fast
 *                           diagnosis. Leave unset in prod.
 *
 * If SMTP env vars are missing the route returns 503 rather than throwing,
 * so the form gives a real error instead of a stack trace.
 */

// Force the Node runtime — nodemailer pulls in node-only modules and the
// edge runtime would silently break SMTP.
export const runtime = "nodejs";

// SMTP handshakes on slow providers can blow past the 10s default; give it
// room to fail with a real error instead of a timeout.
export const maxDuration = 30;

const TO_EMAIL = process.env.WAITLIST_TO_EMAIL ?? "aleksandar@lll.mk";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

interface WaitlistBody {
  email?: string;
  /** Honeypot field; real users leave it empty. Bots fill every input. */
  company?: string;
}

function smtpConfigured(): boolean {
  return Boolean(
    process.env.EMAIL_SERVER_HOST &&
      process.env.EMAIL_SERVER_PORT &&
      process.env.EMAIL_SERVER_USER &&
      process.env.EMAIL_SERVER_PASSWORD &&
      process.env.EMAIL_FROM,
  );
}

function buildWelcomeText(): string {
  return [
    "You're on the list. That's the full confirmation.",
    "",
    "Tally is a Solana wallet where a contactless bank card becomes the signing key,",
    "including expired ones. Built for AI agents that need to spend real money",
    "without the vault key ever touching a server.",
    "",
    "Three things worth a look before we ship:",
    "",
    "  Demo (90 seconds): https://www.youtube.com/watch?v=7ksWSDN4As4",
    "  Code:              https://github.com/alexanxin/tally-vault",
    "  Live x402 endpoint: https://tally.lll.mk/api/signal",
    "",
    "Reply to this email if you want to talk early access, integration, or push",
    "back on the design. Goes straight to my inbox.",
    "",
    "Alex, building Tally",
  ].join("\n");
}

function buildWelcomeHtml(): string {
  // Keep inline styles minimal and email-client-safe (no flex, no grid).
  return `
    <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; background: #0b0f14; color: #e5e5e5; line-height: 1.55;">
      <div style="font-family: monospace; font-size: 11px; color: #4ade80; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 24px;">
        &gt; Tally Waitlist · Confirmed
      </div>

      <p style="margin: 0 0 16px 0; color: #ffffff; font-size: 18px; font-weight: 600;">
        You're on the list. That's the full confirmation.
      </p>

      <p style="margin: 0 0 18px 0; color: #c7cdd4;">
        Tally is a Solana wallet where a contactless bank card becomes the signing key, including expired ones. Built for AI agents that need to spend real money without the vault key ever touching a server.
      </p>

      <p style="margin: 0 0 10px 0; color: #c7cdd4;">
        Three things worth a look before we ship:
      </p>

      <ul style="margin: 0 0 22px 0; padding-left: 20px; color: #c7cdd4;">
        <li style="margin-bottom: 6px;">
          <a href="https://www.youtube.com/watch?v=7ksWSDN4As4" style="color: #4ade80; text-decoration: none;">90-second demo video</a>
        </li>
        <li style="margin-bottom: 6px;">
          <a href="https://github.com/alexanxin/tally-vault" style="color: #4ade80; text-decoration: none;">Code on GitHub</a>
        </li>
        <li style="margin-bottom: 6px;">
          <a href="https://tally.lll.mk/api/signal" style="color: #4ade80; text-decoration: none;">Live x402 endpoint</a>
        </li>
      </ul>

      <p style="margin: 0 0 18px 0; color: #c7cdd4;">
        Reply to this email if you want to talk early access, integration, or push back on the design. Goes straight to my inbox.
      </p>

      <p style="margin: 0 0 0 0; color: #9aa3ad;">
        Alex, building Tally
      </p>
    </div>
  `.trim();
}

function buildEmailHtml(email: string): string {
  const ts = new Date().toISOString();
  return `
    <div style="font-family: 'Inter', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; background: #0b0f14; color: #e5e5e5;">
      <h2 style="color: #4ade80; font-family: monospace; font-size: 16px; letter-spacing: 1.5px; text-transform: uppercase; margin: 0 0 18px 0;">
        Tally — New Waitlist Signup
      </h2>
      <div style="background: #111820; padding: 18px; border: 1px solid #1f2a36;">
        <p style="margin: 0 0 12px 0; color: #e5e5e5;">
          <strong style="color: #4ade80; font-family: monospace; font-size: 12px; letter-spacing: 1px;">EMAIL</strong><br>
          <span style="color: #ffffff; font-family: monospace;">${email}</span>
        </p>
        <p style="margin: 0; color: #9aa3ad; font-family: monospace; font-size: 11px;">
          <strong style="color: #4ade80;">RECEIVED</strong> ${ts}
        </p>
      </div>
      <p style="color: #6b7280; font-size: 11px; margin-top: 20px; font-family: monospace;">
        Sent from tally.lll.mk waitlist form.
      </p>
    </div>
  `.trim();
}

export async function POST(req: NextRequest) {
  let body: WaitlistBody;
  try {
    body = (await req.json()) as WaitlistBody;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request_body" }, { status: 400 });
  }

  // Honeypot: if a bot filled the hidden field we accept silently. Returning
  // 200 keeps the bot from learning anything about how the filter works.
  if (body.company && body.company.trim().length > 0) {
    return NextResponse.json({ ok: true });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ ok: false, error: "email_required" }, { status: 400 });
  }
  if (email.length > 254 || !EMAIL_REGEX.test(email)) {
    return NextResponse.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }

  if (!smtpConfigured()) {
    // Avoid leaking which env var is missing; just say the service is down.
    console.error("Waitlist: SMTP env vars not configured");
    return NextResponse.json(
      { ok: false, error: "service_unavailable" },
      { status: 503 },
    );
  }

  // Auto-detect TLS mode unless explicitly overridden. Wrong port/secure
  // combo (e.g. 465 + secure:false) is the most common SMTP misconfig.
  const smtpPort = Number(process.env.EMAIL_SERVER_PORT!);
  const smtpSecure =
    process.env.EMAIL_SERVER_SECURE === "true" || smtpPort === 465;

  // Single transporter, two sends — same SMTP connection where possible.
  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_SERVER_HOST!,
    port: smtpPort,
    secure: smtpSecure,
    auth: {
      user: process.env.EMAIL_SERVER_USER!,
      pass: process.env.EMAIL_SERVER_PASSWORD!,
    },
  });

  // ── Notification email to ops inbox — REQUIRED. Failure means the
  //    signup is lost, so the response goes 502 and the form shows an
  //    error. The user can retry.
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM!,
      to: TO_EMAIL,
      replyTo: email,
      subject: `Tally waitlist: ${email}`,
      html: buildEmailHtml(email),
    });
  } catch (err) {
    // Log the structured nodemailer fields that actually tell you what's
    // wrong: SMTP reply code, the command that failed, and the server's
    // response. These show up in Vercel function logs.
    const e = err as { message?: string; code?: string; command?: string; response?: string };
    console.error("[waitlist] SMTP send failed:", {
      message: e?.message,
      code: e?.code,
      command: e?.command,
      response: e?.response,
      host: process.env.EMAIL_SERVER_HOST,
      port: smtpPort,
      secure: smtpSecure,
      from: process.env.EMAIL_FROM,
    });
    const debug = process.env.WAITLIST_DEBUG === "1";
    return NextResponse.json(
      {
        ok: false,
        error: "send_failed",
        details: debug
          ? { message: e?.message, code: e?.code, response: e?.response }
          : undefined,
      },
      { status: 502 },
    );
  }

  // ── Welcome email back to the signup — BEST-EFFORT. A failure here
  //    means the user does not get a confirmation, but the signup is
  //    already captured in the ops inbox, so we log and continue rather
  //    than telling the user the whole submission failed.
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM!,
      to: email,
      replyTo: TO_EMAIL,
      subject: "You're on the Tally waitlist",
      text: buildWelcomeText(),
      html: buildWelcomeHtml(),
    });
  } catch (err) {
    const e = err as { message?: string; code?: string; response?: string };
    console.warn("[waitlist] welcome email skipped:", {
      message: e?.message,
      code: e?.code,
      response: e?.response,
      to: email,
    });
  }

  return NextResponse.json({ ok: true });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}

export async function GET() {
  return NextResponse.json(
    {
      endpoint: "POST /api/waitlist",
      method: "POST",
      requestShape: { email: "string (required)", company: "string (honeypot; leave empty)" },
    },
    { status: 405 },
  );
}
