import { useEffect, useRef, useState } from "react";

interface FdWidget {
  init: (opts: { token: string; host: string; widgetId: string }) => void;
  destroy?: () => void;
  user?: { clear: (opts?: { force?: boolean }) => Promise<unknown> | void };
}

declare global {
  interface Window {
    fdWidget?: FdWidget;
  }
}

interface WidgetConfig {
  host: string;
  token: string;
  widgetId: string;
}

const SCRIPT_ID = "Freshdesk-js-sdk";

/**
 * The Freshworks AI Agent, as Freshdesk's own web-chat bubble.
 *
 * Config comes from GET /app-config (FRESHDESK_WIDGET_* in the server .env), so
 * pointing at another Freshdesk account is an .env edit + restart, no rebuild.
 * The token and widget id are the public embed identifiers Freshdesk gives for
 * a page snippet — client-visible by design.
 *
 * It mounts only while this component is on screen and destroys the widget on
 * unmount, so it never sits on top of the ElevenLabs voice bubble on other pages.
 *
 * Reports its state through `onStatus` so the page can say honestly whether the
 * widget loaded, instead of showing an empty panel.
 */
export default function FreshworksWidget({
  onStatus,
  resetKey = 0,
}: {
  onStatus?: (s: "loading" | "ready" | "unavailable") => void;
  /** Bump to throw away the saved conversation and start a fresh one. */
  resetKey?: number;
}) {
  const [cfg, setCfg] = useState<WidgetConfig | null | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const handledReset = useRef(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/app-config")
      .then((res) => res.json())
      .then(({ freshdeskWidget }) => {
        if (!cancelled) setCfg(freshdeskWidget ?? null);
      })
      .catch(() => {
        if (!cancelled) setCfg(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (cfg === undefined) return onStatus?.("loading");
    if (cfg === null) return onStatus?.("unavailable");

    let destroyed = false;

    const init = () => {
      if (destroyed || !window.fdWidget) return onStatus?.("unavailable");
      window.fdWidget.init({ token: cfg.token, host: cfg.host, widgetId: cfg.widgetId });
      setReady(true);
      onStatus?.("ready");
    };

    onStatus?.("loading");
    if (document.getElementById(SCRIPT_ID)) {
      init();
    } else {
      const script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.async = true;
      script.src = `${cfg.host}/webchat/js/widget.js`;
      script.onload = init;
      script.onerror = () => onStatus?.("unavailable");
      document.head.appendChild(script);
    }

    return () => {
      destroyed = true;
      try {
        window.fdWidget?.destroy?.();
      } catch {
        /* the widget may not have finished initialising — nothing to tear down */
      }
    };
  }, [cfg, onStatus]);

  // A conversation handed to a human (or finished) is restored from the browser
  // on every reload, and the AI agent no longer answers it. Clearing the saved
  // user session and re-initialising is what gives the next visitor a fresh chat.
  useEffect(() => {
    if (resetKey === 0 || resetKey === handledReset.current || !cfg || !ready || !window.fdWidget) return;
    handledReset.current = resetKey;
    const w = window.fdWidget;
    const reinit = () => {
      try {
        w.destroy?.();
      } catch {
        /* not initialised yet — nothing to tear down */
      }
      setTimeout(() => w.init({ token: cfg.token, host: cfg.host, widgetId: cfg.widgetId }), 300);
    };
    Promise.resolve(w.user?.clear({ force: true })).then(reinit, reinit);
  }, [resetKey, cfg, ready]);

  return null;
}
