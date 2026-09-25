// Freshdesk web-widget "webchat" API — the same internal endpoints the
// official JS widget itself calls, driven headlessly (no browser/cookies
// needed — verified live 2026-09-24 with just the public widget token, a
// matching referer, and the right request body). This is NOT a documented
// public Freshdesk API: it can change without notice, unlike /api/v2/*.
//
// Why this exists: it lets a non-widget channel (here, voice via ElevenLabs)
// drive the REAL AI Agent Studio bot for the "Resolve" agent — same
// workflow, same OTP/refund logic — instead of only our own /tools/*
// endpoints talking to it indirectly. Two write calls against the internal
// widget API (visitor create, send message) plus one READ call against the
// official, documented REST API (ticket conversations) to fetch the bot's
// reply — see the resolve-freshdesk-ai-agent-setup memory for the full
// captured-request recipe this was built from.

const DOMAIN = () => process.env.FRESHDESK_DOMAIN;
const WIDGET_ID = () => process.env.FRESHDESK_WIDGET_ID;
const WIDGET_TOKEN = () => process.env.FRESHDESK_WIDGET_TOKEN;
const API_KEY = () => process.env.FRESHDESK_API_KEY;

function base(): string {
  return `https://${DOMAIN()}.freshdesk.com`;
}

export function webchatConfigured(): boolean {
  return Boolean(DOMAIN() && WIDGET_ID() && WIDGET_TOKEN() && API_KEY());
}

export interface WebchatVisitor {
  alias: string;
  fdWcToken: string;
}

/** Starts a fresh anonymous webchat session — one per voice call. */
export async function createVisitor(): Promise<WebchatVisitor> {
  const widgetId = WIDGET_ID();
  const token = WIDGET_TOKEN();
  const siteId = Math.random().toString(36).slice(2, 18);
  const res = await fetch(`${base()}/webchat/v1/${widgetId}/visitors?siteId=${siteId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: base(),
      referer: `${base()}/webchat/widget/?token=${token}&widgetId=${widgetId}`,
      "x-webchat-token": token!,
    },
    body: JSON.stringify({ visitor: { meta: { user_timezone: "Asia/Calcutta", language: "", siteId } } }),
  });
  if (!res.ok) {
    throw new Error(`Freshdesk webchat visitor create -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { data: { visitor: { alias: string; fdWcToken: string } } };
  return { alias: data.data.visitor.alias, fdWcToken: data.data.visitor.fdWcToken };
}

/** Posts one message as the visitor. Returns the ticket id and the highest
 *  note id seen in the echoed thread so far, so the caller knows where to
 *  start polling from for the bot's NEXT reply (never re-speaks old notes,
 *  including the bot's own auto-welcome note on the first call). */
export async function sendVisitorMessage(
  visitor: WebchatVisitor,
  text: string,
): Promise<{ ticketId: number; lastNoteId: number }> {
  const widgetId = WIDGET_ID();
  const token = WIDGET_TOKEN();
  const now = Date.now();
  const res = await fetch(
    `${base()}/webchat/v1/${widgetId}/visitors/${visitor.alias}/notes?locale=en&topic_state=1`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: base(),
        referer: `${base()}/webchat/widget/?token=${token}&widgetId=${widgetId}`,
        "x-webchat-token": token!,
        "x-fd-wc-token": visitor.fdWcToken,
      },
      body: JSON.stringify({
        msgHopId: `${now}_${now}`,
        messageType: 1,
        userType: 1,
        topicId: 1,
        productCreatedAt: now,
        bodyContents: [{ type: "text", data: { content: text } }],
        location: JSON.stringify({ url: `${base()}/`, title: "" }),
        isMessageReceived: false,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Freshdesk webchat send message -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    data: { ticket: { ticketId: number; notes?: { noteId: number }[] } };
  };
  const notes = data.data.ticket.notes ?? [];
  const lastNoteId = notes.reduce((max, n) => Math.max(max, n.noteId), 0);
  return { ticketId: data.data.ticket.ticketId, lastNoteId };
}

export interface BotReply {
  text: string;
  lastNoteId: number;
}

/** Polls the OFFICIAL REST API for the bot's next outgoing note(s) after
 *  `sinceNoteId`. Returns null on timeout (bot hasn't replied yet). */
export async function waitForBotReply(
  ticketId: number,
  sinceNoteId: number,
  timeoutMs = 20_000,
  pollMs = 700,
): Promise<BotReply | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base()}/api/v2/tickets/${ticketId}/conversations`, {
      headers: { Authorization: `Basic ${Buffer.from(`${API_KEY()}:X`).toString("base64")}` },
    });
    if (res.ok) {
      const notes = (await res.json()) as { id: number; incoming: boolean; private: boolean; body_text: string }[];
      const replies = notes
        .filter((n) => !n.incoming && !n.private && n.id > sinceNoteId)
        .sort((a, b) => a.id - b.id);
      if (replies.length > 0) {
        return { text: replies.map((n) => n.body_text).join(" "), lastNoteId: replies.at(-1)!.id };
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}
