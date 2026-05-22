import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";

/**
 * POST /api/waitlist
 *
 * Tiny "join the waitlist" endpoint backing the form in the start.html
 * footer CTA. Stateless by design: no database, no dedup, no analytics.
 * Each valid submission becomes an email in the operator inbox; that's the
 * full storage layer.
 *
 * Tradeoff: duplicates just stack in the inbox. Acceptable while the volume
 * is small. Swap in a Vercel KV dedup if it gets noisy.
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
 *
 * If SMTP env vars are missing the route returns 503 rather than throwing,
 * so the form gives a real error instead of a stack trace.
 */

// Force the Node runtime — nodemailer pulls in node-only modules and the
// edge runtime would silently break SMTP.
export const runtime = "nodejs";

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

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_SERVER_HOST!,
      port: Number(process.env.EMAIL_SERVER_PORT!),
      secure: false, // STARTTLS on 587; flip to true if you use 465
      auth: {
        user: process.env.EMAIL_SERVER_USER!,
        pass: process.env.EMAIL_SERVER_PASSWORD!,
      },
    });

    await transporter.sendMail({
      from: process.env.EMAIL_FROM!,
      to: TO_EMAIL,
      replyTo: email,
      subject: `Tally waitlist: ${email}`,
      html: buildEmailHtml(email),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Waitlist send error:", err);
    return NextResponse.json(
      { ok: false, error: "send_failed" },
      { status: 502 },
    );
  }
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
