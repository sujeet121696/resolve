import { useEffect, useState } from "react";
import {
  createDemoTicket,
  getCatalog,
  getPolicyConfig,
  mintPayment,
  saveVelocityCaps,
  verifyContext,
  type CatalogItem,
  type PolicyDto,
} from "../lib/api";

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

  // Policy guard — live velocity caps. Dormant until enabled here.
  const [policy, setPolicy] = useState<PolicyDto | null>(null);
  const [velCcy, setVelCcy] = useState("USD");
  const [velEnabled, setVelEnabled] = useState(false);
  const [velMaxRefunds, setVelMaxRefunds] = useState("");
  const [velMaxCustomer, setVelMaxCustomer] = useState("");
  const [velMaxTotal, setVelMaxTotal] = useState("");
  const [velBusy, setVelBusy] = useState(false);
  const [velMsg, setVelMsg] = useState("");

  function syncVelocityForm(p: PolicyDto, ccy: string) {
    const v = p.currencies[ccy]?.velocity;
    setVelEnabled(Boolean(v));
    setVelMaxRefunds(v?.max_refunds_per_customer_per_day !== undefined ? String(v.max_refunds_per_customer_per_day) : "");
    setVelMaxCustomer(v?.max_amount_per_customer_per_day !== undefined ? String(v.max_amount_per_customer_per_day / 100) : "");
    setVelMaxTotal(v?.max_total_amount_per_day !== undefined ? String(v.max_total_amount_per_day / 100) : "");
  }

  useEffect(() => {
    getCatalog().then((c) => {
      setProducts(c.products);
      setCustomers(c.customers);
      setProductId(c.products[0]?.id ?? "");
      setCustomerId(c.customers[0]?.id ?? "");
    });
    getPolicyConfig().then((p) => {
      setPolicy(p);
      const ccy = p.currencies.USD ? "USD" : Object.keys(p.currencies)[0] ?? "USD";
      setVelCcy(ccy);
      syncVelocityForm(p, ccy);
    });
  }, []);

  function onVelCcyChange(ccy: string) {
    setVelCcy(ccy);
    setVelMsg("");
    if (policy) syncVelocityForm(policy, ccy);
  }

  function onVelEnabledChange(checked: boolean) {
    setVelEnabled(checked);
    // One-click enable: prefill demo-safe defaults when everything is empty,
    // so Enable → Save works without typing. 1 refund/customer/day is the cap
    // that makes a same-day repeat call deny; the amounts are high enough to
    // never interfere with the scripted scenarios.
    if (checked && !velMaxRefunds && !velMaxCustomer && !velMaxTotal) {
      setVelMaxRefunds("1");
      setVelMaxCustomer("50");
      setVelMaxTotal("100");
    }
  }

  async function onSaveVelocity() {
    setVelBusy(true);
    setVelMsg("");
    try {
      const updated = await saveVelocityCaps(velCcy, velEnabled, {
        max_refunds_per_customer_per_day: velMaxRefunds === "" ? undefined : Number(velMaxRefunds),
        max_amount_per_customer_per_day: velMaxCustomer === "" ? undefined : Math.round(Number(velMaxCustomer) * 100),
        max_total_amount_per_day: velMaxTotal === "" ? undefined : Math.round(Number(velMaxTotal) * 100),
      });
      setPolicy(updated);
      syncVelocityForm(updated, velCcy);
      setVelMsg(
        velEnabled
          ? `Velocity caps ENABLED for ${velCcy} — in force for the very next call, no restart.`
          : `Velocity caps disabled for ${velCcy} — guard is back to per-case limits only.`,
      );
    } catch (err) {
      setVelMsg(`Error: ${(err as Error).message}`);
    } finally {
      setVelBusy(false);
    }
  }

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
      <h1>Merchant console</h1>
      <p className="sub">
        Live controls for what the Resolve agent is allowed to do with money — changes take effect on the next call,
        no deploy or restart. Sandbox tooling for new scenarios (test payments, tickets) lives below.
      </p>

      <section className="admin-step">
        <h2>Policy guard — velocity caps (live)</h2>
        <p className="sub">
          Dormant until enabled. Saving updates <code>config/policy.json</code> AND the running guard in one move —
          the very next call obeys it, no restart. Leave a field empty to skip that cap; amounts are in major units
          (e.g. dollars).
        </p>
        <div className="admin-row">
          <select value={velCcy} onChange={(e) => onVelCcyChange(e.target.value)}>
            {Object.keys(policy?.currencies ?? { USD: null }).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={velEnabled} onChange={(e) => onVelEnabledChange(e.target.checked)} />
            Enabled
          </label>
          <input
            type="number"
            min={0}
            placeholder="max refunds / customer / day"
            title="Max refunds one customer may receive per day"
            value={velMaxRefunds}
            onChange={(e) => setVelMaxRefunds(e.target.value)}
            disabled={!velEnabled}
            style={{ width: 190 }}
          />
          <input
            type="number"
            min={0}
            placeholder={`max amount / customer / day (${velCcy})`}
            title="Max refunded amount per customer per day"
            value={velMaxCustomer}
            onChange={(e) => setVelMaxCustomer(e.target.value)}
            disabled={!velEnabled}
            style={{ width: 210 }}
          />
          <input
            type="number"
            min={0}
            placeholder={`daily total ceiling (${velCcy})`}
            title="Circuit breaker: total autonomous refund payout per day"
            value={velMaxTotal}
            onChange={(e) => setVelMaxTotal(e.target.value)}
            disabled={!velEnabled}
            style={{ width: 180 }}
          />
          <button
            onClick={onSaveVelocity}
            disabled={velBusy || !policy || (velEnabled && !velMaxRefunds && !velMaxCustomer && !velMaxTotal)}
          >
            {velBusy ? "Saving…" : "Save"}
          </button>
        </div>
        {policy && (
          <p className="admin-result">
            In force for {velCcy}: auto-approve limit{" "}
            <code>{(policy.currencies[velCcy]?.auto_approve_limit ?? 0) / 100}</code> · velocity caps{" "}
            <b>{policy.currencies[velCcy]?.velocity ? "ON" : "off"}</b>
          </p>
        )}
        {velMsg && <p className="admin-result">{velMsg}</p>}
      </section>

      <section className="admin-step">
        <h2>Sandbox — 1. Mint a test payment</h2>
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
        <h2>Sandbox — 2. Create the matching helpdesk ticket</h2>
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
        <h2>Sandbox — 3. Verify the case resolves correctly</h2>
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
