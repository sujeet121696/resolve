// Thin client for the Express orchestrator. Same-origin in production
// (Express serves the build at /app); proxied by Vite in dev.

export async function sendChat(sessionId: string, message: string): Promise<string> {
  const res = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, message }),
  });
  const data = (await res.json()) as { reply: string };
  return data.reply;
}

export interface CatalogItem {
  id: string;
  name?: string;
  email?: string;
}

export async function getCatalog(): Promise<{ products: CatalogItem[]; customers: CatalogItem[] }> {
  const res = await fetch("/admin/catalog");
  return res.json();
}

export async function mintPayment(
  productId: string,
  customerId: string,
  quantity: number,
): Promise<{ payment_id: string; payment_link: string }> {
  const res = await fetch("/admin/mint-payment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId, customerId, quantity }),
  });
  return res.json();
}

export async function createDemoTicket(orderNumber: string, email: string): Promise<{ ticket_id: string }> {
  const res = await fetch("/admin/create-ticket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderNumber, email }),
  });
  return res.json();
}

export async function verifyContext(email: string): Promise<Record<string, unknown>> {
  const res = await fetch("/admin/verify-context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return res.json();
}
