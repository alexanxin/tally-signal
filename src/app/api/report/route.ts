import { NextRequest, NextResponse } from "next/server";
import { validateReport, formatReport } from "@/lib/report";

// Node runtime — plain fetch to the Telegram Bot API; token stays server-side.
export const runtime = "nodejs";

const ALLOW_ORIGIN = process.env.REPORT_ALLOWED_ORIGIN ?? "*";

function cors(res: NextResponse) {
  res.headers.set("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return cors(NextResponse.json({ ok: false, error: "json" }, { status: 400 }));
  }

  const v = validateReport(body);
  if (!v.ok) return cors(NextResponse.json({ ok: false, error: v.error }, { status: 400 }));

  const token = process.env.TG_TOKEN;
  const chatId = process.env.TG_REPORT_CHAT_ID;
  if (!token || !chatId) {
    return cors(NextResponse.json({ ok: false, error: "unconfigured" }, { status: 503 }));
  }

  const tg = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: formatReport(body), disable_web_page_preview: true }),
  });
  if (!tg.ok) return cors(NextResponse.json({ ok: false, error: "telegram" }, { status: 502 }));

  return cors(NextResponse.json({ ok: true }));
}
