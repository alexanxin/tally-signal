// Pure validation + formatting for inbound bug reports (kept out of the route
// handler so it can be unit-tested independently of Next.js).

export function validateReport(b: any): { ok: boolean; error?: string } {
  if (!b || typeof b !== "object") return { ok: false, error: "body" };
  if (!["bug", "feedback"].includes(b.category)) return { ok: false, error: "category" };
  if (typeof b.description !== "string" || b.description.trim().length === 0) return { ok: false, error: "description" };
  if (b.description.length > 4000) return { ok: false, error: "too_long" };
  if (b.contact != null && (typeof b.contact !== "string" || b.contact.length > 200)) return { ok: false, error: "contact" };
  return { ok: true };
}

export function formatReport(b: any): string {
  const d = b.diagnostics || {};
  return [
    `🐞 Tally ${String(b.category).toUpperCase()}`,
    "",
    b.description,
    "",
    b.contact ? `Contact: ${b.contact}` : "",
    `v${d.appVersion} · ${d.platform} · ${d.network} · ${d.route}`,
  ]
    .filter(Boolean)
    .join("\n");
}
