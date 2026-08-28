// Customer-facing confirmation email — the written half of "voice + email
// confirmation" (DESIGN.md beat 6).
//
// Why a mail of our own instead of the helpdesk's: the resolution note on the
// ticket is deliberately PRIVATE (an audit trail for agents, not a customer
// message), and a Freshdesk public reply would go to the seeded @example.com
// address with no redirect available. Sending it ourselves reuses the SMTP
// path that already works for OTP and honours the demo redirect, so the
// confirmation is visible on screen during a demo.
//
// Contract: this is best-effort. It runs AFTER the money has already moved, so
// a mail failure must never change the outcome of a case — callers log and
// carry on. It also takes the recipient as an argument rather than reading it
// from CaseFacts, keeping customer PII out of the guard's prompt.

import { deliveryAddressFor, fromAddress, mailTransport, smtpConfigured } from "./mailer.js";
import { emitEvent } from "./events.js";

export interface ResolutionMail {
  to: string;
  ticket_id: string;
  order_id: string;
  /** What the caller heard, e.g. "₹1,499" — narrated, not minor units. */
  amount_narrated: string;
  refund_id: string;
  refund_status: string;
}

/** Email the customer the confirmed outcome. Never throws. */
export async function sendResolutionEmail(mail: ResolutionMail): Promise<{ sent: boolean }> {
  if (!smtpConfigured()) {
    emitEvent("notify.skipped", "SMTP not configured — resolution email skipped");
    return { sent: false };
  }

  const deliverTo = deliveryAddressFor(mail.to);
  try {
    await mailTransport().sendMail({
      from: fromAddress(),
      to: deliverTo,
      subject: `Your refund for order ${mail.order_id} is confirmed`,
      text: [
        `Good news — we've processed your refund.`,
        ``,
        `Order:      ${mail.order_id}`,
        `Amount:     ${mail.amount_narrated}`,
        `Refund ref: ${mail.refund_id} (${mail.refund_status})`,
        `Ticket:     #${mail.ticket_id}`,
        ``,
        `The money is on its way back to your original payment method and`,
        `typically appears within 5-7 business days, depending on your bank.`,
        ``,
        `This confirmation was sent automatically after the refund was`,
        `completed, so the reference above is the real transaction id.`,
        ``,
        `— Resolve Support`,
      ].join("\n"),
    });
    emitEvent(
      "notify.sent",
      deliverTo === mail.to
        ? `Confirmation emailed to ${mail.to}`
        : `Confirmation for ${mail.to} redirected to ${deliverTo} (demo)`,
      { ticket_id: mail.ticket_id, refund_id: mail.refund_id },
    );
    return { sent: true };
  } catch (err) {
    // Money has already moved — a mail failure is a warning, never an error.
    emitEvent("case.warn", `Resolution email failed (refund unaffected): ${(err as Error).message}`);
    return { sent: false };
  }
}
