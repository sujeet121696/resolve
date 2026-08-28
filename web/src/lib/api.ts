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
