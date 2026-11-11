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
  v == null || !isFinite(v) ? "--" : `${(v * 100).toFixed(1)}%`;
const timeAgo = (ts) => {
  const d = Date.now() - ts;
  if (d < 5000) return "just now";
  if (d < 60000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  return `${Math.floor(d / 3600000)}h ago`;
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
// A live value older than this fades to gray: a frozen number must never
// look like a current one (a quiet SSE stream keeps the LAST value — it
// never resets it, so staleness must be rendered, not assumed).
const STALE_MS = 30000;
// On subscribe llama-swap replays its whole upstream log buffer as the first
// frame. Those lines carry no timestamps, so nothing in a frame that lands
// this soon after the stream opens can honestly be stamped "now".
const REPLAY_MS = 1000;
const AMBER = "#fbbf24";
// EventSource retries a dropped connection by itself, but gives up for good
// (readyState CLOSED) on a non-200 or wrong content type. Re-open those.
const WATCHDOG_MS = 5000;

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

function MetricCard({ label, value, sub, accent, stale }) {
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
      {
        key: "v",
        style: {
          fontSize: 22,
          fontWeight: 700,
          color: stale ? "var(--muted-foreground, #9ca3af)" : accent || "inherit",
        },
      },
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
    logStreamConnected: false,
    currentModel: null,
    modelKnown: false, // false until the first modelStatus frame arrives
    liveDecodeTps: null,
    liveDecodeAt: null,
    livePrefillTps: null,
    livePrefillAt: null,
    livePromptTokens: null,
    livePromptAt: null,
    recentRequests: [],
    activityError: null,
    lastActivityUpdate: null,
    stats: null,
  });

  // In-flight fetches may resolve after unmount; never setState on a dead component.
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    []
  );

  // --- SSE: llama-swap /api/events emits everything on the default "message"
  // channel as {type, data} envelopes; data is a JSON string needing a 2nd parse. ---

  useEffect(() => {
    let closed = false;
    let es = null;
    let esLog = null;
    let logOpenedAt = 0;
    let logFirstFrame = true;

    const applyModelStatus = (raw) => {
      try {
        const env = JSON.parse(raw); // {type:"modelStatus", data:"<json string>"}
        let models = env.data;
        if (typeof models === "string") models = JSON.parse(models);
        if (Array.isArray(models)) {
          // Every ready model (a group can hold several), and null when none
          // is: an unload has to clear the card, not leave the last name up.
          const ready = models.filter((m) => String(m.state || "").toLowerCase() === "ready");
          const listed = ready.filter((m) => !m.unlisted);
          const ids = (listed.length ? listed : ready).map((m) => m.id || m.name).filter(Boolean);
          setState((s) => ({
            ...s,
            currentModel: ids.length ? ids.join(", ") : null,
            modelKnown: true,
          }));
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
        // NInfer prints "2.46k" style rates; llama.cpp prints plain numbers.
        const num = (s) => {
          const m = String(s).replace(/,/g, "").match(/^([0-9.]+)\s*([kKmM]?)$/);
          if (!m) return null;
          const mult = { k: 1e3, K: 1e3, m: 1e6, M: 1e6 }[m[2]] || 1;
          return parseFloat(m[1]) * mult;
        };
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
          // NInfer (2026-09-24): periodic window line, e.g.
          // "throughput | 5.0s | prefill 2.46k tok/s (12,288 tok) | decode 69.0 tok/s (345 tok) | running 1 (prefill 1) | ..."
          // Windows are mixed (a window can straddle prefill->decode), so only
          // trust a rate when its window did real work of that kind.
          if (line.includes("throughput |")) {
            const pf = line.match(/prefill\s+([0-9.,]+\s*[kKmM]?)\s*tok\/s\s*\(([0-9,]+)\s*tok\)/);
            const dc = line.match(/decode\s+([0-9.,]+\s*[kKmM]?)\s*tok\/s\s*\(([0-9,]+)\s*tok\)/);
            const prefilling = /running\s+\d+\s*\(prefill/.test(line);
            // "running 0" = the request ended inside this window, so its
            // tokens are averaged over dead time and the rate is deflated
            // (seen: "decode 112.2 tok/s ... running 1" then
            // "decode 31.6 tok/s (158 tok) ... running 0").
            const run = line.match(/running\s+(\d+)/);
            const idle = run != null && parseInt(run[1], 10) === 0;
            if (pf) {
              const n = parseInt(pf[2].replace(/,/g, ""), 10);
              if (n >= 1024 || (prefilling && n > 0)) pp = num(pf[1]);
            }
            if (dc) {
              const n = parseInt(dc[2].replace(/,/g, ""), 10);
              if (n >= 32 && !prefilling && !idle) tg = num(dc[1]);
            }
          }
          // NInfer per-request summary: "req#4 done | ... | prompt 107,650 | ... | prefill 1.38k tok/s | decode 61.8 tok/s | ..."
          if (/req#\d+ done \|/.test(line)) {
            const rp = line.match(/\|\s*prompt\s+([0-9,]+)\s*\|/);
            const rpf = line.match(/\|\s*prefill\s+([0-9.,]+\s*[kKmM]?)\s*tok\/s/);
            const rdc = line.match(/\|\s*decode\s+([0-9.,]+\s*[kKmM]?)\s*tok\/s/);
            if (rp) nt = parseInt(rp[1].replace(/,/g, ""), 10);
            if (rpf) pp = num(rpf[1]);
            if (rdc) tg = num(rdc[1]);
          }
          // Strata (2026-11-01): human-readable engine lines, three kinds.
          // Per-request summary — the authoritative prefill+decode pair:
          // "[strata] request prompt 74970 cached 65536 output 244 prompt_read 900 ms total 3200 ms prefill 83.3 tok/s decode 109.4 tok/s"
          if (line.includes("[strata] request prompt")) {
            const sp = line.match(/prompt\s+([0-9,]+)\s+cached/);
            const spf = line.match(/prefill\s+([0-9.]+)\s+tok\/s/);
            const sdc = line.match(/decode\s+([0-9.]+)\s+tok\/s/);
            if (sp) nt = parseInt(sp[1].replace(/,/g, ""), 10);
            if (spf) pp = parseFloat(spf[1]);
            if (sdc) tg = parseFloat(sdc[1]);
          }
          // Live progress: "answering:|thinking:|writing a tool call: ... tokens, 101.2 tok/s, 249 s"
          // (thinking lines are reasoning-token decode — same rate, still decode.)
          const stm = line.match(/\[strata\] (?:answering|thinking|writing a tool call).*tokens,\s*([0-9.]+)\s+tok\/s/);
          if (stm) tg = parseFloat(stm[1]);
          // Completion: "done: 26097 tokens in 255 s (102.7 tok/s) ..."
          const sdn = line.match(/\[strata\] done:\s*([0-9,]+)\s+tokens in\s+[0-9.]+\s+s\s*\(([0-9.]+)\s+tok\/s\)/);
          if (sdn) tg = parseFloat(sdn[2]);
          // Prefill progress (no rate emitted, only the token count):
          // "reading the prompt: 74,970 of 74,975 tokens, 2 s so far"
          const spr = line.match(/\[strata\] reading the prompt:\s*([0-9,]+)\s+of/);
          if (spr) nt = parseInt(spr[1].replace(/,/g, ""), 10);
        }
        // A token count with no rate is still news: Strata reports prefill
        // progress that way ("reading the prompt: N of M") and prints the
        // rate only once the request is done.
        if (tg != null || pp != null || nt != null) {
          const now = Date.now(); // one stamp, so same-frame values compare equal
          setState((s) => ({
            ...s,
            ...(tg != null && { liveDecodeTps: tg, liveDecodeAt: now }),
            ...(pp != null && { livePrefillTps: pp, livePrefillAt: now }),
            ...(nt != null && { livePromptTokens: nt, livePromptAt: now }),
          }));
        }
      } catch {
        /* ignore malformed frames */
      }
    };

    const openEvents = () => {
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
        es = null;
        setState((s) => ({ ...s, streamConnected: false }));
      }
    };

    // Upstream engine stdout (tg_3s, prompt processing, [strata] ...) is
    // served on /api/events/logs?stream=upstream — NOT on /api/events (which
    // only carries modelStatus/inflight/...). Without this subscription the
    // live decode/prefill cards never populate.
    const openLogs = () => {
      if (closed) return;
      try {
        esLog = new EventSource(`${BASE}/api/events/logs?stream=upstream`);
        // onopen fires on every (re)connect, so each one re-arms the replay guard.
        esLog.onopen = () => {
          logOpenedAt = Date.now();
          logFirstFrame = true;
          setState((s) => ({ ...s, logStreamConnected: true }));
        };
        esLog.onerror = () => setState((s) => ({ ...s, logStreamConnected: false }));
        esLog.onmessage = (e) => {
          try {
            const d = JSON.parse(e.data);
            if (d.type !== "logData") return;
            // The first frame after a connect is the replayed history buffer:
            // old lines, no timestamps. Drop it rather than stamp it "now".
            const replay = logFirstFrame && Date.now() - logOpenedAt < REPLAY_MS;
            logFirstFrame = false;
            if (!replay) applyLog(e.data);
          } catch {
            /* ignore */
          }
        };
      } catch {
        esLog = null;
        setState((s) => ({ ...s, logStreamConnected: false }));
      }
    };

    openEvents();
    openLogs();
    const watchdog = setInterval(() => {
      if (closed) return;
      if (!es || es.readyState === 2) {
        if (es) es.close();
        openEvents();
      }
      if (!esLog || esLog.readyState === 2) {
        if (esLog) esLog.close();
        openLogs();
      }
    }, WATCHDOG_MS);

    return () => {
      closed = true;
      clearInterval(watchdog);
      if (es) es.close();
      if (esLog) esLog.close();
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
      if (!aliveRef.current) return;
      setState((s) => ({
        ...s,
        recentRequests: requests,
        activityError: null,
        lastActivityUpdate: Date.now(),
      }));
    } catch (e) {
      if (aliveRef.current) setState((s) => ({ ...s, activityError: e.message }));
    }
  }, []);

  const pollStats = useCallback(async () => {
    try {
      const resp = await fetch(`${BASE}/api/metrics/stats`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (aliveRef.current) setState((s) => ({ ...s, stats: data }));
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
                background: !state.streamConnected
                  ? "#f87171"
                  : !state.logStreamConnected
                  ? AMBER
                  : GREEN,
              },
            }),
            el("span", { key: "lbl", style: muted },
              !state.streamConnected
                ? "stream down (polling)"
                : !state.logStreamConnected
                ? "log stream down (live cards frozen)"
                : "streams connected"),
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
          stale: state.liveDecodeAt != null && Date.now() - state.liveDecodeAt > STALE_MS,
          value: formatTokS(state.liveDecodeTps),
          sub: state.liveDecodeAt != null ? timeAgo(state.liveDecodeAt) : "waiting for generation",
        }),
        el(MetricCard, {
          key: "c2",
          label: "Live Prefill",
          accent: BLUE,
          stale: state.livePrefillAt != null && Date.now() - state.livePrefillAt > STALE_MS,
          value: formatTokS(state.livePrefillTps),
          sub:
            state.livePromptAt != null && state.livePromptAt > (state.livePrefillAt || 0)
              ? // a token count newer than the last rate = a prompt being read now
                `reading prompt · ${state.livePromptTokens.toLocaleString()} tok · ${timeAgo(state.livePromptAt)}`
              : state.livePrefillAt != null
              ? `${state.livePromptTokens != null ? state.livePromptTokens.toLocaleString() + " tok · " : ""}${timeAgo(state.livePrefillAt)}`
              : "waiting for prompt",
        }),
        el(MetricCard, {
          key: "c3",
          label: "Active Model",
          value: state.currentModel || "--",
          sub: state.currentModel
            ? "via modelStatus"
            : state.modelKnown
            ? "no model loaded"
            : "waiting for modelStatus",
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
