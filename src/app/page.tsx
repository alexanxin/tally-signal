export default function Home() {
  const endpoint = "https://tally-signal.vercel.app/api/signal";

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "48px 24px" }}>

      {/* Header */}
      <div style={{ marginBottom: 40 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <span style={{ fontSize: "1.5rem" }}>📡</span>
          <h1 style={{ fontSize: "1.1rem", letterSpacing: 4, color: "var(--green)" }}>
            TALLY SIGNAL
          </h1>
          <span style={{
            fontFamily: "var(--mono)", fontSize: "0.55rem", letterSpacing: 2,
            border: "1px solid var(--green)", color: "var(--green)",
            padding: "2px 8px", opacity: 0.7,
          }}>x402</span>
        </div>
        <p style={{ color: "var(--muted)", fontSize: "0.75rem", lineHeight: 1.6 }}>
          A paywalled market intelligence endpoint. Requires a funded{" "}
          <a href="https://github.com/tally-wallet" style={{ color: "var(--green)" }}>Tally</a>{" "}
          session wallet to access. No API keys, no accounts — just a card tap.
        </p>
      </div>

      {/* 402 demo box */}
      <section style={{
        background: "var(--red-dim)", border: "1px solid rgba(239,68,68,0.3)",
        borderRadius: 4, padding: 20, marginBottom: 24,
      }}>
        <div style={{ fontSize: "0.6rem", letterSpacing: 3, color: "var(--red)", marginBottom: 12 }}>
          WITHOUT SESSION HEADER
        </div>
        <pre style={{ fontSize: "0.7rem", lineHeight: 1.7, overflowX: "auto" }}>{`GET /api/signal HTTP/1.1

HTTP/1.1 402 Payment Required
X-Payment-Required: tally
X-Payment-Amount: 0.5
X-Payment-Currency: USDC

{
  "error": "payment_required",
  "amount": 0.5,
  "currency": "USDC"
}`}</pre>
      </section>

      {/* 200 demo box */}
      <section style={{
        background: "var(--green-dim)", border: "1px solid rgba(132,204,22,0.25)",
        borderRadius: 4, padding: 20, marginBottom: 24,
      }}>
        <div style={{ fontSize: "0.6rem", letterSpacing: 3, color: "var(--green)", marginBottom: 12 }}>
          WITH FUNDED SESSION HEADER
        </div>
        <pre style={{ fontSize: "0.7rem", lineHeight: 1.7, overflowX: "auto" }}>{`GET /api/signal HTTP/1.1
X-Tally-Session: BGz5Hfe1...pZT2z3cr

HTTP/1.1 200 OK

{
  "ok": true,
  "signal": {
    "asset": "SOL/USDC",
    "signal": "BULLISH",
    "confidence": "74%",
    "entry": "$144.57",
    "target": "$152.30  (+5.3%)",
    "stop_loss": "$141.90  (-1.9%)",
    "timeframe": "4H",
    "basis": {
      "structure": "Price trading above 4H 200 EMA",
      "liquidity": "Sweep of equal lows confirmed",
      "orderblock": "Unmitigated bullish OB at entry zone",
      "rr": "1 : 2.8"
    }
  }
}`}</pre>
      </section>

      {/* How it works */}
      <section style={{ marginBottom: 32 }}>
        <div style={{ fontSize: "0.6rem", letterSpacing: 3, color: "var(--muted)", marginBottom: 16 }}>
          HOW IT WORKS
        </div>
        {[
          ["01", "Agent calls GET /api/signal — no header", "Server returns 402 + X-Payment-Required: tally"],
          ["02", "Agent calls request_with_payment(url)", "Pauses, generates Telegram notification with deep link"],
          ["03", "User receives notification on phone", "Opens Tally app, taps bank card to authorize"],
          ["04", "Tally broadcasts USDC transfer on-chain", "Session wallet is funded within seconds"],
          ["05", "Agent retries with X-Tally-Session header", "Server verifies on-chain balance, returns signal"],
          ["06", "Agent calls return_funds()", "Remaining USDC swept back to master vault"],
        ].map(([step, action, result]) => (
          <div key={step} style={{
            display: "grid", gridTemplateColumns: "32px 1fr",
            gap: "0 16px", marginBottom: 16, alignItems: "start",
          }}>
            <span style={{ color: "var(--green)", fontSize: "0.65rem", paddingTop: 2 }}>{step}</span>
            <div>
              <div style={{ fontSize: "0.75rem", marginBottom: 2 }}>{action}</div>
              <div style={{ fontSize: "0.65rem", color: "var(--muted)" }}>{result}</div>
            </div>
          </div>
        ))}
      </section>

      {/* Agent code snippet */}
      <section style={{ marginBottom: 32 }}>
        <div style={{ fontSize: "0.6rem", letterSpacing: 3, color: "var(--muted)", marginBottom: 12 }}>
          AGENT CODE (Python)
        </div>
        <pre style={{
          background: "var(--bg2)", border: "1px solid var(--border)",
          borderRadius: 4, padding: 20, fontSize: "0.7rem", lineHeight: 1.7,
          overflowX: "auto",
        }}>{`from warm_vault_auth import request_with_payment

result = request_with_payment(
    url="${endpoint}",
    amount_usdc=1.0,
    task_description="Fetch SOL/USDC market signal",
    return_funds_after=True,  # sweeps remaining USDC back to vault
)

if result["ok"]:
    signal = result["data"]["signal"]
    print(f"Signal: {signal['signal']} @ {signal['entry']}")
    print(f"Target: {signal['target']}  Stop: {signal['stop_loss']}")`}
        </pre>
      </section>

      {/* Live try */}
      <section style={{
        border: "1px solid var(--border)", borderRadius: 4, padding: 20,
      }}>
        <div style={{ fontSize: "0.6rem", letterSpacing: 3, color: "var(--muted)", marginBottom: 12 }}>
          TRY IT
        </div>
        <div style={{ fontSize: "0.7rem", color: "var(--muted)", marginBottom: 8 }}>
          No session (expect 402):
        </div>
        <code style={{ fontSize: "0.7rem", color: "var(--green)" }}>
          curl {endpoint}
        </code>
        <div style={{ fontSize: "0.7rem", color: "var(--muted)", margin: "16px 0 8px" }}>
          With a funded session wallet:
        </div>
        <code style={{ fontSize: "0.7rem", color: "var(--green)", wordBreak: "break-all" }}>
          curl -H &quot;X-Tally-Session: YOUR_PUBKEY&quot; {endpoint}
        </code>
      </section>

      <footer style={{ marginTop: 48, fontSize: "0.6rem", color: "var(--muted)", textAlign: "center" }}>
        <a href="https://github.com/tally-wallet" style={{ color: "var(--muted)" }}>
          Tally — Physical API Key for Agent Commerce
        </a>
        {" · "}
        <a href="/api/signal" style={{ color: "var(--muted)" }}>API</a>
      </footer>
    </main>
  );
}
