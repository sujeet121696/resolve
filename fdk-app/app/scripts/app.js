/* Resolve case-brief sidebar.
 *
 * Reads GET /tools/case-brief?ticket_id=<id> through the Freshworks request
 * proxy (config/requests.json) — the tools token is a secure iparam
 * substituted server-side, so it never reaches this browser code.
 *
 * The one action offered — "mark return received" — is the warehouse-scan
 * hook the demo script otherwise fires via curl. It is two-click armed so a
 * stray tap can't unblock a refund by accident.
 */

let client = null;
let armed = false;

document.addEventListener("DOMContentLoaded", function () {
  app
    .initialized()
    .then(function (c) {
      client = c;
      client.instance.resize({ height: "460px" });
      document.getElementById("refresh").addEventListener("click", load);
      load();
    })
    .catch(function (err) {
      show('<div class="err">App failed to initialize: ' + esc(err && err.message) + "</div>");
    });
});

function load() {
  armed = false;
  show('<div class="dim">Loading case brief…</div>');
  client.data
    .get("ticket")
    .then(function (data) {
      return client.request.invokeTemplate("getCaseBrief", {
        context: { ticket_id: String(data.ticket.id) },
      });
    })
    .then(function (res) {
      render(JSON.parse(res.response));
    })
    .catch(function (err) {
      show(
        '<div class="err">Could not load the Resolve brief — is the server/tunnel up?</div>' +
          '<div class="note">' + esc(extractError(err)) + "</div>",
      );
    });
}

function render(brief) {
  if (!brief.order_id) {
    show('<div class="dim">Resolve has not handled this ticket yet — no case context on record.</div>');
    return;
  }

  const html =
    renderHeader(brief) + renderReturn(brief) + renderAction(brief) + renderEvents(brief);
  show(html);

  const scan = document.getElementById("scan");
  if (scan) {
    scan.addEventListener("click", function () {
      onScan(brief.order_id);
    });
  }
}

function renderHeader(brief) {
  let html =
    '<div class="row"><b>' + esc(brief.order_id) + "</b>" +
    (brief.amount ? " · " + esc(brief.amount) : "") + "</div>";

  html += '<div class="pills">';
  html += '<span class="pill ok">approved × ' + brief.guard.approved + "</span>";
  html += '<span class="pill bad">denied × ' + brief.guard.denied + "</span>";
  const checks = uniqueCounts(brief.guard.denial_checks);
  Object.keys(checks).forEach(function (c) {
    html += '<span class="pill warn">' + esc(c) + " × " + checks[c] + "</span>";
  });
  html += "</div>";

  const o = brief.outcomes;
  html +=
    '<div class="row dim">' +
    o.refunds + " refunds · " + o.refunds_blocked + " blocked · " +
    o.returns_requested + " returns · " + o.escalations + " escalations (order history)</div>";
  return html;
}

function renderReturn(brief) {
  let html = '<div class="section"><h4>Return</h4>';
  if (brief.return) {
    html +=
      '<div class="row"><b>' + esc(brief.return.rma) + "</b> — " +
      '<span class="pill ' + (brief.return.state === "received" ? "ok" : "warn") + '">' +
      esc(brief.return.state) + "</span></div>";
    if (brief.return.state === "requested") {
      html +=
        '<button id="scan" class="action-btn">Mark return received (warehouse scan)</button>' +
        '<div class="note">Unblocks the refund on the next call — two clicks required.</div>';
    }
  } else {
    html += '<div class="dim">No RMA on this order.</div>';
  }
  return html + "</div>";
}

function renderAction(brief) {
  let html = '<div class="section"><h4>Action record</h4>';
  if (brief.action) {
    html +=
      '<div class="row"><span class="pill ' + (brief.action.state === "done" ? "ok" : "bad") + '">' +
      esc(brief.action.state) + "</span> " + esc(brief.action.action) + "</div>";
    if (brief.action.state === "in_flight") {
      html += '<div class="note">In-flight: a human must check whether money moved before any retry.</div>';
    }
  } else {
    html += '<div class="dim">No money action recorded — clean idempotency slot.</div>';
  }
  return html + "</div>";
}

function renderEvents(brief) {
  let html =
    '<div class="section"><h4>Audit trail (' + brief.events.length + ')</h4><div class="events">';
  brief.events
    .slice()
    .reverse()
    .forEach(function (e) {
      html +=
        '<div class="ev"><span class="ts">' + esc(fmtTs(e.ts)) + "</span> " +
        '<span class="ty">' + esc(e.type) + "</span>" +
        '<div class="msg">' + esc(e.message) + "</div></div>";
    });
  return html + "</div></div>";
}

function onScan(orderId) {
  const btn = document.getElementById("scan");
  if (!armed) {
    armed = true;
    btn.classList.add("confirm");
    btn.textContent = "Confirm: parcel scanned in for " + orderId + "?";
    return;
  }
  btn.disabled = true;
  btn.textContent = "Marking received…";
  client.request
    .invokeTemplate("markReturnReceived", { body: JSON.stringify({ order_id: orderId }) })
    .then(function () {
      load();
    })
    .catch(function (err) {
      btn.disabled = false;
      btn.textContent = "Failed — try again";
      notify(extractError(err));
    });
}

function notify(message) {
  client.interface.trigger("showNotify", { type: "danger", message: message }).catch(function (err) {
    console.warn("showNotify failed", err);
  });
}

function uniqueCounts(list) {
  const out = {};
  (list || []).forEach(function (x) {
    out[x] = (out[x] || 0) + 1;
  });
  return out;
}

function fmtTs(iso) {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

function extractError(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  try {
    const body = err.response ? JSON.parse(err.response) : null;
    if (body && (body.error || body.message)) return body.error || body.message;
  } catch (parseErr) {
    console.warn("error body was not JSON", parseErr);
  }
  return err.message || JSON.stringify(err);
}

function esc(s) {
  const str = s === null || s === undefined ? "" : String(s);
  return str.replace(/[&<>"']/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}

function show(html) {
  document.getElementById("content").innerHTML = html;
}
