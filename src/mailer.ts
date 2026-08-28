// Shared SMTP plumbing for every outbound email (OTP codes, resolution
// confirmations).
//
// Extracted so the DEMO REDIRECT RULE lives in exactly one place: seeded
// customers use @example.com addresses that have no real inbox, so their mail
// is delivered to OTP_DEMO_REDIRECT_TO instead while the agent still narrates
// the customer's own address. If that rule ever diverged between the OTP and
// the confirmation, half a demo would silently vanish.

import nodemailer from "nodemailer";

export function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function mailTransport() {
  const port = Number(process.env.SMTP_PORT ?? 465);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? "smtp.gmail.com",
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

export function fromAddress(): string {
  return `"Resolve Support" <${process.env.OTP_FROM_ADDRESS ?? process.env.SMTP_USER}>`;
}

/**
 * Where mail for `email` actually goes. Real addresses are returned unchanged;
 * seeded @example.com addresses are redirected when OTP_DEMO_REDIRECT_TO is set.
 */
export function deliveryAddressFor(email: string): string {
  const redirect = process.env.OTP_DEMO_REDIRECT_TO;
  return redirect && email.endsWith("@example.com") ? redirect : email;
}
