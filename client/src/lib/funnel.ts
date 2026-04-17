// Lightweight funnel-event tracker. Fire-and-forget; never blocks the UI.
// Failures are swallowed — analytics must never break the app.

const SESSION_KEY = "amax_funnel_session";

function getSessionId(): string {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return `s_${Date.now().toString(36)}`;
  }
}

export type FunnelEventName =
  | "flow_a_step_view"
  | "flow_a_step_complete"
  | "flow_a_recommendation_view"
  | "lead_captured"
  | "apply_started"
  | "apply_submitted";

export function trackEvent(event: FunnelEventName, metadata?: Record<string, unknown>): void {
  try {
    const payload = JSON.stringify({
      event,
      sessionId: getSessionId(),
      path: typeof window !== "undefined" ? window.location.pathname : null,
      metadata: metadata ?? null,
    });
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([payload], { type: "application/json" });
      const ok = navigator.sendBeacon("/api/funnel", blob);
      if (ok) return;
    }
    fetch("/api/funnel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // intentionally swallow
  }
}
