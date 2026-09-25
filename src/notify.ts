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

interface ResolutionMailBase {
  to: string;
  ticket_id: string;
  order_id: string;
}

export interface RefundMail extends ResolutionMailBase {
  kind: "refund";
  /** What the caller heard, e.g. "₹1,499" — narrated, not minor units. */
  amount_narrated: string;
  refund_id: string;
  refund_status: string;
}

export interface PlanChangeMail extends ResolutionMailBase {
  kind: "plan_change";
  new_product_id: string;
  /** What was actually billed today, narrated — e.g. "$15.00" or "$0.00 (nothing charged today)". */
  charged_narrated: string;
  subscription_id: string;
}

export type ResolutionMail = RefundMail | PlanChangeMail;

function subjectFor(mail: ResolutionMail): string {
  return mail.kind === "refund"
    ? `Your refund for order ${mail.order_id} is confirmed`
    : `Your plan change for order ${mail.order_id} is confirmed`;
}

function bodyFor(mail: ResolutionMail): string {
  const detail =
    mail.kind === "refund"
      ? [
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
        ]
      : [
          `Good news — your plan change is confirmed.`,
          ``,
          `Order:        ${mail.order_id}`,
          `New plan:     ${mail.new_product_id}`,
          `Charged now:  ${mail.charged_narrated}`,
          `Subscription: ${mail.subscription_id}`,
          `Ticket:       #${mail.ticket_id}`,
          ``,
          `Your next invoice will reflect the new plan going forward.`,
          ``,
          `This confirmation was sent automatically after the change was`,
          `applied, so the details above are live from your subscription.`,
        ];
  return [...detail, ``, `— Resolve Support`].join("\n");
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
      subject: subjectFor(mail),
      text: bodyFor(mail),
    });
    emitEvent(
      "notify.sent",
      deliverTo === mail.to
        ? `Confirmation emailed to ${mail.to}`
        : `Confirmation for ${mail.to} redirected to ${deliverTo} (demo)`,
      { ticket_id: mail.ticket_id, ...(mail.kind === "refund" ? { refund_id: mail.refund_id } : { subscription_id: mail.subscription_id }) },
    );
    return { sent: true };
  } catch (err) {
    // Money has already moved — a mail failure is a warning, never an error.
    emitEvent("case.warn", `Resolution email failed (${mail.kind} unaffected): ${(err as Error).message}`);
    return { sent: false };
  }
}
