/**
 * Intent binding, the composition that makes Tally's facilitator an intent hub.
 *
 * A standard x402 facilitator answers "did the payment settle." This binds a
 * verified spend-authority attestation to a verified payment, so a settled
 * payment also carries proof that a real human authorized the paying agent,
 * bounded on-chain. The link it enforces:
 *
 *   - the attestation is a valid, card-tap-signed spend authority (verified via
 *     the same recipe as /api/attest/verify-authority, on-chain allowance and all)
 *   - the human-approved agent is EXACTLY the party that signed this payment
 *   - the settled amount is within the human-authorized cap
 *
 * Result: human approval, bounded authority, settled draw, all in one response
 * and each independently verifiable.
 */
import { verifySpendAuthority, type SpendAuthAttestation } from "@/lib/attest/spend-authority";
import { type VerifyOutcome } from "@/lib/x402/facilitator";

const VERIFY_AUTHORITY_URL = "https://tally.lll.mk/api/attest/verify-authority";

export interface IntentBinding {
  bound: boolean;
  reason?: string;
  humanApproval?: {
    vault?: string;
    agent: string;
    mint?: string;
    capAtomic?: number;
    expiryTs?: number;
    delegationPda?: string;
    issuer?: string;
  };
  verifyUrl: string;
}

/**
 * Bind a verified `exact` payment to a spend-authority attestation.
 * Call ONLY with a verified payment outcome (outcome.isValid).
 */
export async function bindSpendAuthority(
  outcome: VerifyOutcome,
  attestation: SpendAuthAttestation | string,
  cluster: "devnet" | "mainnet" = "devnet",
): Promise<IntentBinding> {
  const verifyUrl = VERIFY_AUTHORITY_URL;
  if (!outcome.isValid || !outcome.payer) {
    return { bound: false, reason: "payment_not_verified", verifyUrl };
  }

  const r = await verifySpendAuthority(attestation, { verifyAllowance: true, cluster });
  if (!r.valid || !r.claim) {
    return { bound: false, reason: r.reason ?? "attestation_invalid", verifyUrl };
  }

  // The human-approved agent must be the party that signed the payment.
  if (r.claim.agent !== outcome.payer) {
    return { bound: false, reason: "attestation_agent_not_payer", verifyUrl };
  }

  // The settled amount must be within the human-authorized cap.
  const amount = outcome.amountAtomic ?? 0;
  const cap = r.claim.capAtomic ?? 0;
  if (amount > cap) {
    return { bound: false, reason: "payment_exceeds_authorized_cap", verifyUrl };
  }

  return {
    bound: true,
    verifyUrl,
    humanApproval: {
      vault: r.claim.vault,
      agent: r.claim.agent,
      mint: r.claim.mint,
      capAtomic: r.claim.capAtomic,
      expiryTs: r.claim.expiryTs,
      delegationPda: r.claim.delegationPda,
      issuer: r.issuer,
    },
  };
}
