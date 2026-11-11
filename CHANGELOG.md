# Changelog

## Unreleased — branch `live-fixes` (2026-11-10)

Written against llama-swap **v268** (commit 2576af3). Nothing below has been
exercised inside Hermes Desktop yet: `plugin.js` passes `node --check`, and the
endpoint behaviour each fix relies on was observed with `curl` on Nevermore,
but the UI itself is unverified. Each entry ends with how to check it.

Not covered here: whether the Hermes Desktop update of ~2026-11-05 changed
anything in `@hermes/plugin-sdk` (`ROUTES_AREA`, `SIDEBAR_NAV_AREA`, the
`{id, name, register}` default export). If the sidebar item is missing after a
reload, look there first — none of these fixes touch registration.

### 1. Replayed log history is no longer shown as live

On every connect, `/api/events/logs?stream=upstream` first sends llama-swap's
whole log buffer as one frame (about 13 KB when observed). The lines carry no
timestamps, and the plugin stamped whatever rates it found in them with
`Date.now()`, so a connect or reconnect showed old numbers as current for 30 s.
The first `logData` frame within `REPLAY_MS` (1 s) of the log stream's `onopen`
is now dropped. `onopen` fires on reconnects too, so each one is covered.

**Verify:** with a model loaded but idle for over a minute, open the Inference
Monitor page. Live Decode and Live Prefill should read `--` / "waiting for
generation" / "waiting for prompt", not the last request's rates marked "just
now". Then send a request: the cards should populate normally. Repeat after
`systemctl --user restart llama-swap` (Greg's call, not casually) to cover the
reconnect path.

Known edge: if the buffer is empty at connect (fresh llama-swap, nothing
logged) and a real frame arrives inside that first second, that one frame is
lost. The next one lands normally.

### 2. Active Model follows unloads and shows every ready model

The card only ever updated when a ready model existed, and the activity poll
filled it in from the most recent request's model. After an unload or TTL
expiry it kept naming a model that was no longer loaded. It now tracks
`modelStatus` exactly: all ready models joined with ", " (a group such as
`duo` holds two), and empty when none are ready. The activity-poll fallback
is gone. Before the first `modelStatus` frame the card says "waiting for
modelStatus" rather than "no model loaded".

**Verify:** note the card with the daily driver loaded; unload it (llama-swap
UI, or let the TTL lapse) and confirm the card goes to `--` / "no model
loaded". Load a `duo` group and confirm both ids appear.

Assumption to confirm: that llama-swap sends a `modelStatus` frame when a
model stops. It sends one on connect (observed); the on-change frame was not
observed directly.

### 3. A token count without a rate is no longer discarded

State only updated when a decode or prefill rate was present, so Strata's
`reading the prompt: N of M tokens` lines (count, no rate) were parsed and then
thrown away. They now update the prompt-token count on their own. While that
count is newer than the last prefill rate, the Live Prefill card's sub-line
reads `reading prompt · N tok · <age>`; once the request's summary line
arrives it returns to the usual `N tok · <age>`.

**Verify:** send a Strata slot a large uncached prompt. During prefill the sub-
line should count up under "reading prompt"; when the request finishes it
should show the final prompt size beside the measured rate.

Known edge: a request cancelled mid-prefill leaves "reading prompt" up until
the next request. The age beside it keeps counting, so it does not pass for
current.

### 4. NInfer: the window after a request ends no longer overwrites decode

NInfer's periodic `throughput |` line averages over a fixed window. The window
in which a request finishes reports its last tokens spread over the whole
window. From this box's logs:

    throughput | 5.0s | decode 112.2 tok/s (561 tok) | running 1 (decode-ready 1) | ...
    throughput | 5.0s | decode 31.6 tok/s (158 tok) | running 0 | ...

The second line passed the existing guards (≥32 tokens, not prefilling) and
left Live Decode on 31.6 until the next request. Windows that end with
`running 0` are now ignored for decode. The `req#N done` summary is unaffected.

**Verify:** run a request on `ninfer-agent27b` and watch Live Decode as it
finishes: it should settle on the `req#N done` figure, not drop to a fraction
of it a few seconds later.

### 5. The log stream's health is visible, and dead streams are reopened

The second EventSource had no `onopen`/`onerror`, and the status dot reflected
only `/api/events`, so a dead log stream looked healthy while the live cards
froze. The dot now has three states: green "streams connected", amber "log
stream down (live cards frozen)", red "stream down (polling)". A 5 s watchdog
reopens either EventSource if the browser has given up on it
(`readyState === CLOSED`, which happens on a non-200 or wrong content type;
plain connection drops are retried by the browser itself).

**Verify:** with the page open, restart llama-swap. The dot should go red,
then return to green without reloading the page, and the next request should
populate the live cards. Amber is hard to produce on purpose; treat it as
checked if red → green works.

### 6. A real 0% draft acceptance is shown as 0.0%

`formatPct` rendered `0` as `--`. Requests with no drafter still show `--`
(the row passes `null` when `draft_tokens` is 0); a drafter that ran and had
nothing accepted now shows `0.0%`.

**Verify:** by reading — one condition removed in `formatPct`. In practice it
needs a drafted request with zero accepted tokens to see.

## Also on this branch

`353f134` commits the working-tree changes from 2026-11-01 as they stood: the
second EventSource and the NInfer and Strata parsers. On v268, `/api/events`
carries no `logData` frames at all (types seen: `modelStatus`, `inflight`,
`uiConfig`, `profileChanged`, `pauseChanged`), so that subscription is what
makes the live cards work in the first place.
