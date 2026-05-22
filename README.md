# tally-signal

**x402 signal server and website for [Tally](https://github.com/alexanxin/tally-vault).**

Live at [tally.lll.mk](https://tally.lll.mk), deployed on Vercel.

---

## What it is

Two things in one repo:

1. **`/api/signal`**: a paywalled endpoint that demonstrates x402 end-to-end. An agent hits it, gets a 402 with payment instructions in the response, sends 0.1 USDC on-chain, and retries with the transaction signature. The server verifies the transfer independently on Solana mainnet before returning the signal. No API keys. No trust required on either side.

2. **Website**: the public-facing Tally site with intro, story, screenshots, integration guide, x402 explainer, demo video, and APK downloads.

---

## Try it

```bash
curl https://tally.lll.mk/api/signal
```

Returns a self-documenting 402:

```json
{
  "error": "payment_required",
  "message": "This endpoint requires on-chain USDC payment to the Tally signal wallet.",
  "payment_amount": 0.1,
  "currency": "USDC",
  "payment_wallet": "Cz7cUcYS...",
  "how_to_pay": "Send 0.1 USDC to Cz7cUcYS..., then retry with headers: X-Tally-Session: <pubkey> and X-Tally-Tx: <tx_signature>"
}
```

Pay, then retry:

```bash
curl https://tally.lll.mk/api/signal \
  -H "X-Tally-Session: <your_session_pubkey>" \
  -H "X-Tally-Tx: <tx_signature>"
```

---

## x402 flow

```
Agent -> GET /api/signal
      <- 402 { payment_wallet, payment_amount, how_to_pay }

Agent -> send 0.1 USDC on-chain to payment_wallet

Agent -> GET /api/signal
         X-Tally-Session: <pubkey>
         X-Tally-Tx: <tx_signature>
      <- 200 { ok: true, signal: { ... } }
```

The server polls the RPC node up to 4 times (8 seconds) to handle propagation lag. Once confirmed, it verifies the destination ATA is owned by the payment wallet, the mint is USDC, the amount meets the minimum, and the transaction is not older than 5 minutes (replay protection).

---

## Route

`src/app/api/signal/route.ts` is the full handler.

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `SOLANA_RPC_URL` | mainnet public | Solana RPC endpoint |
| `SIGNAL_PAYMENT_WALLET` | *(required for on-chain mode)* | Destination USDC wallet |
| `SIGNAL_PAYMENT_AMOUNT` | `0.1` | Required payment in USDC |
| `SIGNAL_MIN_BALANCE` | `0.5` | Min session balance for proof-of-authorization mode |
| `SIGNAL_TX_MAX_AGE` | `300` | Max transaction age in seconds (replay protection) |

**Two verification modes:**

- **On-chain settlement** (when `SIGNAL_PAYMENT_WALLET` is set): verifies an actual on-chain USDC transfer to the payment wallet. Real money moves.
- **Proof-of-authorization** (no `SIGNAL_PAYMENT_WALLET`): verifies the session wallet holds at least `SIGNAL_MIN_BALANCE` USDC. Useful for testing against devnet.

---

## Proof-of-Presence verification

`POST /api/attest/verify` runs the full server-side verification flow for a Tally Proof-of-Presence token. x402 gateways and agent-payment counterparties can call this once instead of re-implementing the verifier themselves.

The signature on a PoP token only proves "someone with this secret key signed these bytes." A serious verifier needs more. This endpoint runs the five checks documented in [tally-vault README → Proof of Presence](https://github.com/alexanxin/tally-vault#proof-of-presence):

1. Ed25519 signature against the **expected vault pubkey** (which the caller supplies out-of-band, never trusted from the token itself).
2. Cross-check that the payload's `vault` field equals the expected vault — catches substitution by a malicious intermediary.
3. Optional binding: payload `session` equals the session pubkey the agent is presenting from.
4. On-chain settlement: fetches `txSig` and confirms a real USDC or SOL transfer of `amount` from `vault` to `session` actually landed. This is the load-bearing check; money moved.
5. Freshness: payload `ts` is within `ttlSeconds` of now.

Nonce dedup (step 6 in the README) is verifier-side policy and lives wherever you consume the verified token.

### Request

```bash
curl -X POST https://tally.lll.mk/api/attest/verify \
  -H "Content-Type: application/json" \
  -d '{
    "token": { "payload": "...", "sig": "...", "vaultPubkey": "..." },
    "expectedVault": "<base58 vault pubkey, anchored out-of-band>",
    "expectedSession": "<base58 session pubkey, optional>",
    "verifySettlement": true,
    "ttlSeconds": 86400
  }'
```

| Field              | Required | Notes                                                                 |
|--------------------|----------|-----------------------------------------------------------------------|
| `token`            | yes      | The PoP token, either as an object or a JSON string of one.          |
| `expectedVault`    | yes      | Base58 vault pubkey. The trust anchor. Never trusted from the token. |
| `expectedSession`  | no       | When set, payload session must match exactly.                        |
| `verifySettlement` | no       | Defaults `true`. Set `false` to skip the on-chain RPC fetch.         |
| `ttlSeconds`       | no       | Defaults 86400 (24h). Older tokens are rejected as `stale`.          |

### Response

```jsonc
// 200 — fully verified
{
  "valid": true,
  "checks": {
    "signature":    "ok",
    "vaultMatch":   "ok",
    "sessionMatch": "ok" | "skipped",
    "settlement":   "ok" | "skipped",
    "freshness":    "ok"
  },
  "payload":    { "vault": "...", "session": "...", "amount": 0.1, ... },
  "settlement": { "txSig": "...", "amount": 0.1, "destination": "...", "blockTime": ... },
  "note": "Nonce dedup (step 7) is verifier-side policy; this endpoint does not maintain a seen-set across requests."
}

// 200 — any check failed
{
  "valid": false,
  "reason": "sig_verify_failed" | "vault_mismatch" | "session_mismatch"
          | "stale" | "tx_not_found_after_4_attempts" | "no_matching_transfer_in_tx" | ...,
  "checks": { ... },
  "payload": { ... }       // present once signature has cleared
}
```

`GET /api/attest/verify` returns the request schema as JSON with HTTP 405; useful for `curl`-ing the docs.

---

## Website pages

| File | URL |
|------|-----|
| `public/start.html` | `/` |
| `public/story.html` | `/story.html` |
| `public/screenshots.html` | `/screenshots.html` |
| `public/integration.html` | `/integration.html` |
| `public/x402.html` | `/x402.html` |
| `public/deck.pdf` | `/deck.pdf` |

APK downloads are served from `public/` and linked from the Download menu on every page.

---

## Deploy

Standard Next.js on Vercel. Set environment variables in the Vercel dashboard.

```bash
npm install
npm run dev    # local dev server
npm run build  # production build
```

---

## Related

- **Mobile app + agent skill**: [github.com/alexanxin/tally-vault](https://github.com/alexanxin/tally-vault)
- **Live x402 endpoint**: [tally.lll.mk/api/signal](https://tally.lll.mk/api/signal)
