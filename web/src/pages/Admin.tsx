import { useEffect, useState } from "react";
import { createDemoTicket, getCatalog, mintPayment, verifyContext, type CatalogItem } from "../lib/api";

export default function Admin() {
  const [products, setProducts] = useState<CatalogItem[]>([]);
  const [customers, setCustomers] = useState<CatalogItem[]>([]);
  const [productId, setProductId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [payment, setPayment] = useState<{ payment_id: string; payment_link: string } | null>(null);
  const [mintBusy, setMintBusy] = useState(false);

  const [orderNumber, setOrderNumber] = useState("");
  const [email, setEmail] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [ticketBusy, setTicketBusy] = useState(false);

  const [verifyResult, setVerifyResult] = useState<Record<string, unknown> | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);

  useEffect(() => {
    getCatalog().then((c) => {
      setProducts(c.products);
      setCustomers(c.customers);
      setProductId(c.products[0]?.id ?? "");
      setCustomerId(c.customers[0]?.id ?? "");
    });
  }, []);

  async function onMint() {
    setMintBusy(true);
    setPayment(null);
    try {
      const result = await mintPayment(productId, customerId, quantity);
      setPayment(result);
      const c = customers.find((c) => c.id === customerId);
      if (c?.email) setEmail(c.email);
    } finally {
      setMintBusy(false);
    }
  }

  async function onCreateTicket() {
    setTicketBusy(true);
    setTicketId("");
    try {
      const result = await createDemoTicket(orderNumber, email);
      setTicketId(String(result.ticket_id));
    } finally {
      setTicketBusy(false);
    }
  }

  async function onVerify() {
    setVerifyBusy(true);
    try {
      setVerifyResult(await verifyContext(email));
    } finally {
      setVerifyBusy(false);
    }
  }

  const notePreview = payment ? `dodo_payment_id: ${payment.payment_id}` : "";

  return (
    <div className="admin">
      <h1>Demo scenario setup</h1>
      <p className="sub">
        Mints a real Dodo test payment and creates the matching Freshdesk ticket. The Shopify order itself still has
        to be created manually in Shopify Admin (read-only scope, by design) — this just speeds up the other two.
      </p>

      <section className="admin-step">
        <h2>1. Mint a test payment</h2>
        <div className="admin-row">
          <select value={productId} onChange={(e) => setProductId(e.target.value)}>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.email}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
            style={{ width: 70 }}
          />
          <button onClick={onMint} disabled={mintBusy}>
            {mintBusy ? "Minting…" : "Mint payment link"}
          </button>
        </div>
        {payment && (
          <div className="admin-result">
            <p>
              Pay this with <code>4242 4242 4242 4242</code> (any future expiry/CVC):{" "}
              <a href={payment.payment_link} target="_blank" rel="noreferrer">
                {payment.payment_link}
              </a>
            </p>
            <p>
              Payment id: <code>{payment.payment_id}</code>
            </p>
            <p>
              Paste this exact text into the Shopify order's <b>Note</b> field: <code>{notePreview}</code>
            </p>
          </div>
        )}
      </section>

      <section className="admin-step">
        <h2>2. After creating the Shopify order, create the matching ticket</h2>
        <div className="admin-row">
          <input
            placeholder="Shopify order number, e.g. 1004"
            value={orderNumber}
            onChange={(e) => setOrderNumber(e.target.value)}
          />
          <select value={email} onChange={(e) => setEmail(e.target.value)}>
            <option value="">select email…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.email}>
                {c.email}
              </option>
            ))}
          </select>
          <button onClick={onCreateTicket} disabled={ticketBusy || !orderNumber || !email}>
            {ticketBusy ? "Creating…" : "Create ticket"}
          </button>
        </div>
        {ticketId && (
          <p className="admin-result">
            Ticket #{ticketId} created — subject <code>Refund request for order ORD-{orderNumber}</code>
          </p>
        )}
      </section>

      <section className="admin-step">
        <h2>3. Verify it resolves correctly before testing live</h2>
        <div className="admin-row">
          <button onClick={onVerify} disabled={verifyBusy || !email}>
            {verifyBusy ? "Checking…" : `Verify get-context for ${email || "…"}`}
          </button>
        </div>
        {verifyResult && <pre className="admin-verify">{JSON.stringify(verifyResult, null, 2)}</pre>}
      </section>
    </div>
  );
}
