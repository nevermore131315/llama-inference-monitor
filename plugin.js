import { jsxs, jsx } from "react/jsx-runtime";
import { ROUTES_AREA, SIDEBAR_NAV_AREA } from "@hermes/plugin-sdk";
import { useState, useEffect, useRef, useCallback } from "react";

const BASE = "http://127.0.0.1:8091";

// CRITICAL: in react/jsx-runtime, jsx(type, props, maybeKey) — the THIRD argument
// is the key, NOT children. Children must live inside props. This helper enforces it.
const el = (type, props, children) => {
  if (children === undefined) return jsx(type, props);
  if (Array.isArray(children)) return jsxs(type, { ...props, children });
  return jsx(type, { ...props, children });
};

// --- formatting ---

const formatTokS = (v) => {
  if (v == null || !isFinite(v)) return "--";
  return v >= 1000 ? `${Math.round(v)} tok/s` : `${v.toFixed(1)} tok/s`;
};
const formatPct = (v) =>
  v == null || !isFinite(v) || v === 0 ? "--" : `${(v * 100).toFixed(1)}%`;
const timeAgo = (ts) => {
  const d = Date.now() - ts;
  if (d < 5000) return "just now";
  if (d < 60000) return `${Math.floor(d / 1000)}s ago`;
  return `${Math.floor(d / 60000)}m ago`;
};

// --- styles ---

const card = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 8,
};
const muted = { color: "var(--muted-foreground, #9ca3af)" };
const GREEN = "#4ade80";
const BLUE = "#60a5fa";
const PURPLE = "#a78bfa";

// --- Sparkline ---

function Sparkline({ data, width = 420, height = 60, color = GREEN }) {
  if (!data || data.length < 2)
    return el("svg", {
      width,
      height,
      style: { ...card, display: "block", width: "100%", maxWidth: width },
    });
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data
    .map(
      (v, i) =>
        `${((i / (data.length - 1)) * width).toFixed(1)},${(
          height - 4 - ((v - min) / range) * (height - 8)
        ).toFixed(1)}`
    )
    .join(" ");
  return el(
    "svg",
    { width, height, style: { display: "block", width: "100%", maxWidth: width } },
    el("polyline", {
      points: pts,
      fill: "none",
      stroke: color,
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    })
  );
}

// --- Metric card ---

function MetricCard({ label, value, sub, accent }) {
  return el("div", { style: { ...card, padding: "10px 12px" } }, [
    el(
      "div",
      {
        key: "l",
        style: {
          ...muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        },
      },
      label
    ),
    el(
      "div",
      { key: "v", style: { fontSize: 22, fontWeight: 700, color: accent || "inherit" } },
      value
    ),
    sub
      ? el("div", { key: "s", style: { ...muted, fontSize: 11, marginTop: 2 } }, sub)
      : null,
  ].filter(Boolean));
}

// --- Activity row ---

const GRID = "1fr 86px 86px 60px";

function ActivityRow({ req }) {
  const mtp = req.draft_tokens > 0 ? req.draft_acc_tokens / req.draft_tokens : null;
  return el(
    "div",
    {
      style: {
        display: "grid",
        gridTemplateColumns: GRID,
        gap: 8,
        padding: "6px 0",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
        fontSize: 12,
      },
    },
    [
      el("span", { key: "m", style: muted }, req.model),
      el("span", { key: "d", style: { color: GREEN } }, formatTokS(req.decode_tps)),
      el("span", { key: "p", style: { color: BLUE } }, formatTokS(req.prefill_tps)),
      el("span", { key: "t", style: { color: PURPLE } }, formatPct(mtp)),
    ]
  );
}

// --- Main component ---

function LlamaMonitor() {
  const [state, setState] = useState({
    streamConnected: false,
    currentModel: null,
    liveDecodeTps: null,
    liveDecodeAt: null,
    livePrefillTps: null,
    livePrefillAt: null,
    livePromptTokens: null,
    recentRequests: [],
    activityError: null,
    lastActivityUpdate: null,
    stats: null,
  });

  // --- SSE: llama-swap /api/events emits everything on the default "message"
  // channel as {type, data} envelopes; data is a JSON string needing a 2nd parse. ---

  useEffect(() => {
    let closed = false;
    let es;

    const applyModelStatus = (raw) => {
      try {
        const env = JSON.parse(raw); // {type:"modelStatus", data:"<json string>"}
        let models = env.data;
        if (typeof models === "string") models = JSON.parse(models);
        if (Array.isArray(models)) {
          const ready =
            models.find((m) => String(m.state || "").toLowerCase() === "ready" && !m.unlisted) ||
            models.find((m) => String(m.state || "").toLowerCase() === "ready");
          const id = ready && (ready.id || ready.name);
          if (id) setState((s) => ({ ...s, currentModel: id }));
        }
      } catch {
        /* ignore malformed frames */
      }
    };

    const applyLog = (raw) => {
      try {
        const env = JSON.parse(raw); // {type:"logData", data:"<json string>"}
        let payload = env.data;
        if (typeof payload === "string") {
          try { payload = JSON.parse(payload); } catch { payload = { data: payload }; }
        }
        const source = payload && payload.source;
        if (source && source !== "upstream") return; // skip proxy access logs
        const blob = (payload && (payload.data || payload.line || payload.message)) || "";
        if (typeof blob !== "string" || !blob) return;
        // upstream frames arrive BATCHED (many lines per frame) — keep last match.
        let tg = null, pp = null, nt = null;
        for (const line of blob.split("\n")) {
          const m1 = line.match(/tg_3s\s*=\s*([0-9.]+)/);
          if (m1) tg = parseFloat(m1[1]);
          // "prompt processing, n_tokens = 26473, progress = 1.00, t = 34.31 s / 771.61 tokens per second"
          if (line.includes("prompt processing")) {
            const m2 = line.match(/\/\s*([0-9.]+)\s+tokens per second/);
            if (m2) pp = parseFloat(m2[1]);
            const m3 = line.match(/n_tokens\s*=\s*([0-9]+)/);
            if (m3) nt = parseInt(m3[1], 10);
          }
        }
        if (tg != null || pp != null)
          setState((s) => ({
            ...s,
            ...(tg != null && { liveDecodeTps: tg, liveDecodeAt: Date.now() }),
            ...(pp != null && { livePrefillTps: pp, livePrefillAt: Date.now() }),
            ...(nt != null && { livePromptTokens: nt }),
          }));
      } catch {
        /* ignore malformed frames */
      }
    };

    const connect = () => {
      if (closed) return;
      try {
        es = new EventSource(`${BASE}/api/events`);
        es.onopen = () => setState((s) => ({ ...s, streamConnected: true }));
        es.onerror = () => setState((s) => ({ ...s, streamConnected: false }));
        // llama-swap emits everything on the default "message" channel;
        // dispatch on the envelope's .type field.
        es.onmessage = (e) => {
          try {
            const d = JSON.parse(e.data);
            if (d.type === "modelStatus") applyModelStatus(e.data);
            else if (d.type === "logData") applyLog(e.data);
          } catch {
            /* ignore */
          }
        };
      } catch {
        setState((s) => ({ ...s, streamConnected: false }));
      }
    };

    connect();
    return () => {
      closed = true;
      if (es) es.close();
    };
  }, []);

  // --- Activity + stats polling ---

  const pollActivity = useCallback(async () => {
    try {
      const resp = await fetch(`${BASE}/api/metrics/activity?page=1&limit=10`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const rows = data.data || data.rows || [];
      const requests = rows.map((row) => {
        const t = row.tokens || {};
        return {
          model: row.model,
          decode_tps: t.tokens_per_second,
          prefill_tps: t.prompt_per_second,
          input_tokens: t.input_tokens,
          output_tokens: t.output_tokens,
          cache_tokens: t.cache_tokens,
          draft_tokens: t.draft_tokens,
          draft_acc_tokens: t.draft_acc_tokens,
          duration_ms: row.duration_ms,
          timestamp: row.timestamp,
        };
      });
      setState((s) => ({
        ...s,
        recentRequests: requests,
        activityError: null,
        lastActivityUpdate: Date.now(),
        currentModel: s.currentModel || (requests[0] && requests[0].model) || null,
      }));
    } catch (e) {
      setState((s) => ({ ...s, activityError: e.message }));
    }
  }, []);

  const pollStats = useCallback(async () => {
    try {
      const resp = await fetch(`${BASE}/api/metrics/stats`);
      if (!resp.ok) return;
      const data = await resp.json();
      setState((s) => ({ ...s, stats: data }));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    pollActivity();
    pollStats();
    const a = setInterval(pollActivity, 2000);
    const b = setInterval(pollStats, 10000);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [pollActivity, pollStats]);

  // --- derived: oldest→newest for sparkline ---

  const decodeHistory = state.recentRequests
    .filter((r) => r.decode_tps != null)
    .map((r) => r.decode_tps)
    .reverse();

  // --- render tree (built as a keyed array, no nulls) ---

  const children = [];

  children.push(
    el(
      "div",
      {
        key: "header",
        style: {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        },
      },
      [
        el("h1", { key: "t", style: { margin: 0, fontSize: 18, fontWeight: 600 } },
          "Llama Inference Monitor"),
        el(
          "div",
          {
            key: "status",
            style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12 },
          },
          [
            el("span", {
              key: "dot",
              style: {
                width: 8,
                height: 8,
                borderRadius: "50%",
                display: "inline-block",
                background: state.streamConnected ? GREEN : "#f87171",
              },
            }),
            el("span", { key: "lbl", style: muted },
              state.streamConnected ? "stream connected" : "stream down (polling)"),
          ]
        ),
      ]
    )
  );

  children.push(
    el(
      "div",
      {
        key: "cards",
        style: {
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 10,
          marginBottom: 16,
        },
      },
      [
        el(MetricCard, {
          key: "c1",
          label: "Live Decode",
          accent: GREEN,
          value: formatTokS(state.liveDecodeTps),
          sub: state.liveDecodeAt != null ? timeAgo(state.liveDecodeAt) : "waiting for generation",
        }),
        el(MetricCard, {
          key: "c2",
          label: "Live Prefill",
          accent: BLUE,
          value: formatTokS(state.livePrefillTps),
          sub:
            state.livePrefillAt != null
              ? `${state.livePromptTokens != null ? state.livePromptTokens.toLocaleString() + " tok · " : ""}${timeAgo(state.livePrefillAt)}`
              : "waiting for prompt",
        }),
        el(MetricCard, {
          key: "c3",
          label: "Active Model",
          value: state.currentModel || "--",
          sub: state.currentModel ? "via modelStatus" : "no model loaded",
        }),
      ]
    )
  );

  if (state.stats) {
    children.push(
      el(
        "div",
        { key: "stats", style: { ...card, padding: "12px 14px", marginBottom: 16 } },
        [
          el("div", { key: "h", style: { ...muted, fontSize: 11, marginBottom: 8 } },
            `AGGREGATE — ${state.stats.total_requests ?? 0} REQUESTS`),
          el(
            "div",
            {
              key: "g",
              style: {
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
                gap: 10,
                fontSize: 12,
              },
            },
            [
              el("div", { key: "d50" }, [
                el("div", { style: muted }, "Decode p50"),
                el("div", { style: { fontWeight: 600, color: GREEN } },
                  formatTokS(state.stats.gen_histogram?.p50)),
              ]),
              el("div", { key: "d95" }, [
                el("div", { style: muted }, "Decode p95"),
                el("div", { style: { fontWeight: 600, color: GREEN } },
                  formatTokS(state.stats.gen_histogram?.p95)),
              ]),
              el("div", { key: "p50" }, [
                el("div", { style: muted }, "Prefill p50"),
                el("div", { style: { fontWeight: 600, color: BLUE } },
                  formatTokS(state.stats.prompt_histogram?.p50)),
              ]),
              el("div", { key: "p95" }, [
                el("div", { style: muted }, "Prefill p95"),
                el("div", { style: { fontWeight: 600, color: BLUE } },
                  formatTokS(state.stats.prompt_histogram?.p95)),
              ]),
            ]
          ),
        ]
      )
    );
  }

  if (decodeHistory.length > 1) {
    children.push(
      el(
        "div",
        { key: "spark", style: { ...card, padding: "12px 14px", marginBottom: 16 } },
        [
          el("div", { key: "h", style: { ...muted, fontSize: 11, marginBottom: 8 } },
            "DECODE SPEED — RECENT REQUESTS"),
          el(Sparkline, { key: "s", data: decodeHistory }),
        ]
      )
    );
  }

  let tableBody;
  if (state.activityError)
    tableBody = [
      el("div", { key: "err", style: { padding: 12, color: "#f87171", fontSize: 12 } },
        `llama-swap not reachable: ${state.activityError}`),
    ];
  else if (!state.recentRequests.length)
    tableBody = [
      el("div", { key: "empty", style: { padding: 12, ...muted, fontSize: 12 } },
        "No recent activity"),
    ];
  else
    tableBody = state.recentRequests.map((req, i) =>
      el(ActivityRow, { key: `req-${i}`, req })
    );

  children.push(
    el(
      "div",
      { key: "activity", style: { ...card, padding: "12px 14px" } },
      [
        el(
          "div",
          {
            key: "h",
            style: {
              display: "flex",
              justifyContent: "space-between",
              fontSize: 11,
              marginBottom: 8,
            },
          },
          [
            el("span", { key: "t", style: muted }, "RECENT REQUESTS"),
            el("span", { key: "u", style: muted },
              state.lastActivityUpdate ? `updated ${timeAgo(state.lastActivityUpdate)}` : "loading…"),
          ]
        ),
        el(
          "div",
          {
            key: "cols",
            style: {
              display: "grid",
              gridTemplateColumns: GRID,
              gap: 8,
              fontSize: 11,
              fontWeight: 600,
              borderBottom: "1px solid rgba(255,255,255,0.08)",
              paddingBottom: 4,
            },
          },
          [
            el("span", { key: "1", style: muted }, "Model"),
            el("span", { key: "2", style: muted }, "Decode"),
            el("span", { key: "3", style: muted }, "Prefill"),
            el("span", { key: "4", style: muted }, "MTP"),
          ]
        ),
        ...tableBody,
      ]
    )
  );

  return el(
    "div",
    {
      style: {
        height: "100%",
        overflow: "auto",
        padding: 16,
        fontSize: 14,
        color: "var(--foreground, #e5e7eb)",
      },
    },
    children
  );
}

// --- Plugin registration (pattern from hermes-memory-ui) ---

function register(ctx) {
  ctx.register({
    id: "page",
    area: ROUTES_AREA,
    data: { path: "/llama-monitor" },
    render: () => el(LlamaMonitor, {}),
  });
  ctx.register({
    id: "nav",
    area: SIDEBAR_NAV_AREA,
    data: { path: "/llama-monitor", label: "Inference Monitor", codicon: "graph" },
  });
}

const plugin = {
  id: "llama-inference-monitor",
  name: "Inference Monitor",
  defaultEnabled: true,
  register,
};

export { plugin as default };
