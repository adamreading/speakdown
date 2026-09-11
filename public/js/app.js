/**
 * Speakdown — application wiring.
 *
 * Flow for one utterance:
 *
 *   mic -> AudioWorklet frames -> VAD segments a clip -> WAV encode
 *       -> POST /api/transcribe -> AssemblyAI Sync endpoint
 *       -> strip fillers -> parse commands -> apply to document -> render
 *
 * Two details worth knowing before reading on:
 *
 * Ordered concurrency. Requests fire as soon as a clip is ready, so speaking
 * three sentences in a row puts three requests in flight at once. But they are
 * *applied* strictly in the order they were spoken, via a sequence number and
 * a pending map. Without this, a fast short clip overtakes a slow long one and
 * your document comes out scrambled — the single most likely way a dictation
 * app built on a sync endpoint goes wrong.
 *
 * One snapshot per utterance. "Scratch that" should undo the last thing you
 * said, not the last internal operation, so the document snapshots once per
 * utterance regardless of how many commands that utterance contained.
 */

import { Recorder, RecorderState } from "./recorder.js";
import { LiveDictation, DemoDictation, DEMO_SCRIPT } from "./dictation.js";
import { SpeakdownDoc } from "./doc.js";
import { commandGroups, KEYTERMS } from "./commands.js";
import { applyTranscript } from "./pipeline.js";
import { wordCount } from "./text.js";
import { renderMarkdown, highlightSource } from "./markdown.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const el = {};
const state = {
  config: null,
  mode: "demo",
  doc: new SpeakdownDoc(),
  client: null,
  recorder: null,
  running: false,
  demoRunning: false,
  demoAbort: false,
  editingSource: false,

  settings: {
    language: "en",
    fillerLevel: "standard",
    captureMode: "vad",
    punctuation: false,
    heatmap: true,
    autoscroll: true,
  },

  latencies: [],
  levels: new Array(110).fill(0),
  threshold: 0.01,
  currentLevel: 0,
  meterMood: "idle",

  seq: 0,
  nextToApply: 0,
  pending: new Map(),
  inFlight: 0,
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheElements();
  buildCommandPalette();
  bindEvents();
  startMeterLoop();
  restoreSettings();

  try {
    const response = await fetch("/api/config");
    state.config = await response.json();
  } catch {
    state.config = { mode: "demo", languages: [{ code: "en", label: "English" }] };
  }

  state.mode = state.config.mode === "live" ? "live" : "demo";
  state.client = state.mode === "live" ? new LiveDictation() : new DemoDictation();

  populateLanguages();
  applyModeChrome();
  render();
}

function cacheElements() {
  const ids = [
    "app", "workspace", "rail", "modePill", "modeLabel", "language",
    "btnCopy", "btnDownload", "btnClear", "btnRail", "banner", "bannerText",
    "bannerClose", "source", "sourceEdit", "emptyState", "preview", "docStats",
    "commandList", "activity", "activityEmpty", "fillerLevel", "captureMode",
    "togglePunctuation", "toggleHeatmap", "toggleAutoscroll", "btnEditSource",
    "metaEndpoint", "metaModel", "metaKeyterms", "metaContext",
    "btnMic", "btnDemo", "meter", "status", "statusHint",
    "statLatency", "statMedian", "statWords", "statFillers", "statCommands",
    "toasts",
  ];
  for (const id of ids) el[id] = document.getElementById(id);
  el.railTabs = [...document.querySelectorAll(".rail-tab")];
  el.meterCtx = el.meter.getContext("2d");
}

function applyModeChrome() {
  const live = state.mode === "live";
  el.modePill.classList.toggle("is-live", live);
  el.modePill.classList.toggle("is-demo", !live);
  el.modeLabel.textContent = live ? "Live" : "Demo";
  el.modePill.title = live
    ? "Connected to the AssemblyAI Sync endpoint"
    : "No API key configured — replaying a scripted document";

  el.btnDemo.hidden = live;
  el.metaEndpoint.textContent = state.config?.endpoint || "sync.assemblyai.com/transcribe";
  el.metaModel.textContent = state.config?.model || "universal-3-5-pro";
  el.metaKeyterms.textContent = `${KEYTERMS.length} phrases, every request`;

  if (!live) {
    showBanner(
      "Demo Mode — no API key set, so this replays a scripted document with simulated " +
        "latencies. Add ASSEMBLYAI_API_KEY to .env and restart for real dictation.",
    );
    el.statusHint.textContent = "Press Play demo to watch it build a document";
  }
}

function populateLanguages() {
  const languages = state.config?.languages || [{ code: "en", label: "English" }];
  el.language.innerHTML = languages
    .map((l) => `<option value="${l.code}">${l.label}</option>`)
    .join("");
  el.language.value = state.settings.language;
  if (el.language.selectedIndex === -1) {
    el.language.value = "en";
    state.settings.language = "en";
  }
}

// ---------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------

function buildCommandPalette() {
  el.commandList.innerHTML = commandGroups()
    .map(
      (group) => `
      <div class="cmd-group">
        <h3>${group.name}</h3>
        ${group.commands
          .map((cmd) => {
            const phrase = (cmd.phrases[0] || cmd.strictPhrases?.[0] || cmd.id);
            const alt = [...(cmd.phrases || []), ...(cmd.strictPhrases || [])].slice(1);
            const title = alt.length ? ` title="also: ${escapeAttr(alt.join(", "))}"` : "";
            return `
              <div class="cmd" data-command="${cmd.id}"${title}>
                <span class="cmd-phrase">“${escapeHtmlText(phrase)}”</span>
                ${cmd.hint ? `<span class="cmd-hint">${escapeHtmlText(cmd.hint)}</span>` : ""}
              </div>`;
          })
          .join("")}
      </div>`,
    )
    .join("");
}

function flashCommand(cmd) {
  const node = el.commandList.querySelector(`[data-command="${cmd.id}"]`);
  if (node) {
    node.classList.remove("is-fired");
    // Force a reflow so the animation restarts on a repeated command.
    void node.offsetWidth;
    node.classList.add("is-fired");
    setTimeout(() => node.classList.remove("is-fired"), 1400);
  }
  toast(cmd.label, "▸");
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function bindEvents() {
  el.btnMic.addEventListener("click", toggleDictation);
  el.btnDemo.addEventListener("click", toggleDemo);

  el.btnCopy.addEventListener("click", copyMarkdown);
  el.btnDownload.addEventListener("click", downloadMarkdown);
  el.btnClear.addEventListener("click", clearDocument);
  el.btnRail.addEventListener("click", toggleRail);
  el.bannerClose.addEventListener("click", () => (el.banner.hidden = true));
  el.btnEditSource.addEventListener("click", toggleSourceEditing);

  el.language.addEventListener("change", () => {
    state.settings.language = el.language.value;
    state.client?.resetContext?.();
    persistSettings();
  });

  el.fillerLevel.addEventListener("change", () => {
    state.settings.fillerLevel = el.fillerLevel.value;
    persistSettings();
  });

  el.captureMode.addEventListener("change", () => {
    state.settings.captureMode = el.captureMode.value;
    state.recorder?.setMode(state.settings.captureMode);
    updateStatus();
    persistSettings();
  });

  el.togglePunctuation.addEventListener("change", () => {
    state.settings.punctuation = el.togglePunctuation.checked;
    persistSettings();
  });

  el.toggleHeatmap.addEventListener("change", () => {
    state.settings.heatmap = el.toggleHeatmap.checked;
    el.app.classList.toggle("no-heatmap", !state.settings.heatmap);
    persistSettings();
  });

  el.toggleAutoscroll.addEventListener("change", () => {
    state.settings.autoscroll = el.toggleAutoscroll.checked;
    persistSettings();
  });

  for (const tab of el.railTabs) {
    tab.addEventListener("click", () => selectTab(tab.dataset.tab));
  }

  // Push-to-talk on Space, plus shortcuts.
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);

  window.addEventListener("resize", sizeMeter);
  sizeMeter();
}

function onKeyDown(event) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
  const meta = event.metaKey || event.ctrlKey;

  if (meta && event.key === "Enter") {
    event.preventDefault();
    toggleDictation();
    return;
  }
  if (meta && event.key.toLowerCase() === "s") {
    event.preventDefault();
    downloadMarkdown();
    return;
  }
  if (meta && event.shiftKey && event.key.toLowerCase() === "c") {
    event.preventDefault();
    copyMarkdown();
    return;
  }
  if (typing) return;

  if (event.code === "Space" && state.settings.captureMode === "ptt" && state.running) {
    if (!event.repeat) {
      event.preventDefault();
      state.recorder?.pttDown();
    }
  }
}

function onKeyUp(event) {
  if (event.code === "Space" && state.settings.captureMode === "ptt" && state.running) {
    event.preventDefault();
    state.recorder?.pttUp();
  }
}

function selectTab(name) {
  for (const tab of el.railTabs) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  for (const panel of document.querySelectorAll(".rail-panel")) {
    panel.classList.toggle("is-active", panel.id === `tab-${name}`);
  }
}

function toggleRail() {
  const hidden = el.workspace.classList.toggle("rail-hidden");
  el.btnRail.setAttribute("aria-expanded", String(!hidden));
  sizeMeter();
}

// ---------------------------------------------------------------------------
// Dictation lifecycle
// ---------------------------------------------------------------------------

async function toggleDictation() {
  if (state.mode === "demo") {
    // No key: the mic would capture fine but every request would 503.
    toast("Demo Mode — add an API key for live dictation", "!", "error");
    return;
  }
  if (state.running) return stopDictation();
  return startDictation();
}

async function startDictation() {
  if (state.editingSource) toggleSourceEditing();

  state.recorder = new Recorder(
    {
      onUtterance: handleUtterance,
      onLevel: (level, threshold) => {
        state.currentLevel = level;
        state.threshold = threshold;
      },
      onState: onRecorderState,
    },
  );
  state.recorder.setMode(state.settings.captureMode);

  try {
    await state.recorder.start();
  } catch (err) {
    state.recorder = null;
    const denied = /denied|NotAllowed/i.test(String(err?.name || err?.message || err));
    showBanner(
      denied
        ? "Microphone access was blocked. Allow it in your browser's site settings and try again."
        : `Could not start the microphone: ${err?.message || err}`,
      true,
    );
    setStatus("Mic blocked", "is-error");
    return;
  }

  state.running = true;
  el.btnMic.setAttribute("aria-label", "Stop dictation");
  updateStatus();
}

async function stopDictation() {
  state.running = false;
  await state.recorder?.stop();
  state.recorder = null;
  state.meterMood = "idle";
  el.btnMic.classList.remove("is-listening", "is-speaking");
  el.btnMic.setAttribute("aria-label", "Start dictation");
  setStatus("Idle");
  el.statusHint.textContent =
    state.settings.captureMode === "ptt"
      ? "Push to talk — hold Space while the mic is on"
      : "Press the mic, or hit ⌘/Ctrl + Enter";
}

function onRecorderState(recState, detail) {
  if (recState === RecorderState.SPEAKING) {
    el.btnMic.classList.remove("is-listening");
    el.btnMic.classList.add("is-speaking");
    state.meterMood = "speaking";
    setStatus("Speaking", "is-speaking");
    el.statusHint.textContent = "Pause for about 700 ms to send the clip";
  } else if (recState === RecorderState.LISTENING) {
    el.btnMic.classList.remove("is-speaking");
    el.btnMic.classList.add("is-listening");
    state.meterMood = "listening";
    if (state.inFlight === 0) {
      setStatus("Listening");
      el.statusHint.textContent =
        state.settings.captureMode === "ptt" ? "Hold Space to talk" : "Say something";
    }
  } else if (recState === RecorderState.IDLE) {
    state.meterMood = "idle";
  } else if (recState === RecorderState.DENIED || recState === RecorderState.UNSUPPORTED) {
    showBanner(detail?.reason || "Microphone unavailable.", true);
  }
  updateStatus();
}

function updateStatus() {
  if (state.inFlight > 0) {
    setStatus(`Transcribing${state.inFlight > 1 ? ` ×${state.inFlight}` : ""}`, "is-working");
    el.statusHint.textContent = "Request in flight";
    return;
  }
  if (!state.running && !state.demoRunning) return;
  if (state.recorder?.state === RecorderState.SPEAKING) return;
  setStatus(state.demoRunning ? "Demo running" : "Listening");
}

function setStatus(text, cls = "") {
  el.status.textContent = text;
  el.status.className = `status ${cls}`.trim();
}

// ---------------------------------------------------------------------------
// Utterance handling — ordered concurrency
// ---------------------------------------------------------------------------

async function handleUtterance(utterance) {
  const id = state.seq++;
  state.inFlight++;
  updateStatus();

  try {
    const result = await state.client.transcribe(utterance.blob, {
      language: state.settings.language,
    });
    state.pending.set(id, { result, utterance });
  } catch (err) {
    state.pending.set(id, { error: err, utterance });
  } finally {
    state.inFlight--;
    drainPending();
    updateStatus();
  }
}

function drainPending() {
  while (state.pending.has(state.nextToApply)) {
    const item = state.pending.get(state.nextToApply);
    state.pending.delete(state.nextToApply);
    state.nextToApply++;
    if (item.error) reportTranscriptionError(item.error);
    else if (item.result) applyResult(item.result);
  }
}

/**
 * Turn one API response into document changes.
 * @param {object} result
 */
function applyResult(result) {
  const raw = String(result.text || "").trim();
  if (!raw) return;

  state.doc.recordWords(result.words);

  const report = applyTranscript(state.doc, raw, {
    fillerLevel: state.settings.fillerLevel,
    punctuation: state.settings.punctuation,
  });

  for (const cmd of report.commands) flashCommand(cmd);
  for (const warning of report.warnings) toast(warning, "!", "error");

  if (report.control === "stop") {
    if (state.demoRunning) stopDemo();
    else stopDictation();
  }

  if (report.appliedText) state.client.pushContext?.(report.prose);

  logActivity(result, { removed: report.removed, commands: report.commands });
  recordLatency(result);
  render();
}

function reportTranscriptionError(err) {
  const code = err.code || "error";
  const authIssue = err.status === 401 || err.status === 403 || code === "no_api_key";

  logActivityError(err);

  if (authIssue) {
    showBanner(
      "AssemblyAI rejected the API key. Check ASSEMBLYAI_API_KEY in .env and restart the server.",
      true,
    );
    stopDictation();
  } else if (err.status === 429) {
    showBanner(
      `Rate limited by AssemblyAI${err.retryAfter ? ` — retry after ${err.retryAfter}s` : ""}. ` +
        "Speak in longer stretches to send fewer, larger clips.",
      true,
    );
  } else if (code === "audio_too_short") {
    // Routine: a cough or a door. Not worth bothering the user about.
    return;
  } else {
    toast(err.message || "Transcription failed", "!", "error");
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  const markdown = state.doc.toMarkdown();
  const empty = state.doc.isEmpty();

  const lowConfidence = new Set(
    state.doc.lowConfidenceTerms(0.75).map((entry) => entry.word),
  );

  if (!state.editingSource) {
    el.source.innerHTML = highlightSource(markdown, lowConfidence);
  }
  el.preview.innerHTML = renderMarkdown(markdown);
  el.emptyState.hidden = !empty;

  const words = wordCount(markdown.replace(/[#>`*_~\-[\]()]/g, " "));
  state.doc.stats.words = words;
  el.docStats.textContent = `${words} word${words === 1 ? "" : "s"}`;
  el.statWords.textContent = String(words);
  el.statFillers.textContent = String(state.doc.stats.fillersRemoved);
  el.statCommands.textContent = String(state.doc.stats.commands);

  if (state.settings.autoscroll) {
    requestAnimationFrame(() => {
      for (const pane of [el.source.parentElement, el.preview.parentElement]) {
        if (pane) pane.scrollTop = pane.scrollHeight;
      }
    });
  }
}

function recordLatency(result) {
  const round = result._speakdown?.roundTripMs ?? result.request_time_ms;
  if (typeof round !== "number") return;

  state.latencies.push(round);
  if (state.latencies.length > 500) state.latencies.shift();

  el.statLatency.textContent = `${round}ms`;
  el.statLatency.parentElement.title =
    `server ${result.request_time_ms ?? "?"}ms · network ${result._speakdown?.networkMs ?? "?"}ms`;

  const sorted = [...state.latencies].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  el.statMedian.textContent = `${median}ms`;
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

function logActivity(result, { removed, commands }) {
  el.activityEmpty.hidden = true;

  const round = result._speakdown?.roundTripMs ?? result.request_time_ms ?? 0;
  const confidence = typeof result.confidence === "number" ? result.confidence : null;

  const chips = [
    `<span class="chip ${round <= 250 ? "chip-fast" : "chip-slow"}">${round}ms</span>`,
    result.request_time_ms != null
      ? `<span class="chip">srv ${result.request_time_ms}ms</span>`
      : "",
    confidence != null ? `<span class="chip">conf ${(confidence * 100).toFixed(0)}%</span>` : "",
    result.audio_duration_ms
      ? `<span class="chip">${(result.audio_duration_ms / 1000).toFixed(1)}s audio</span>`
      : "",
    commands.length
      ? `<span class="chip chip-cmd">${commands.length} cmd</span>`
      : "",
    removed ? `<span class="chip">−${removed} filler</span>` : "",
  ]
    .filter(Boolean)
    .join("");

  const item = document.createElement("li");
  item.className = "act";
  item.innerHTML = `<p class="act-text">${escapeHtmlText(result.text)}</p><div class="act-meta">${chips}</div>`;
  el.activity.prepend(item);

  while (el.activity.children.length > 40) el.activity.lastElementChild.remove();
}

function logActivityError(err) {
  el.activityEmpty.hidden = true;
  const item = document.createElement("li");
  item.className = "act";
  item.innerHTML =
    `<p class="act-text">${escapeHtmlText(err.message || "Request failed")}</p>` +
    `<div class="act-meta"><span class="chip chip-err">${escapeHtmlText(err.code || "error")}</span></div>`;
  el.activity.prepend(item);
}

// ---------------------------------------------------------------------------
// Level meter
// ---------------------------------------------------------------------------

function sizeMeter() {
  const rect = el.meter.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  el.meter.width = Math.max(160, Math.floor(rect.width * dpr));
  el.meter.height = Math.floor(34 * dpr);
  el.meterCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function startMeterLoop() {
  const tick = () => {
    state.levels.push(state.currentLevel);
    state.levels.shift();
    drawMeter();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function drawMeter() {
  const ctx = el.meterCtx;
  const w = el.meter.width / (window.devicePixelRatio || 1);
  const h = el.meter.height / (window.devicePixelRatio || 1);
  ctx.clearRect(0, 0, w, h);

  const count = state.levels.length;
  const gap = 2;
  const barWidth = Math.max(1.5, w / count - gap);
  const mid = h / 2;

  const colours = {
    idle: "rgba(107, 115, 130, 0.5)",
    listening: "rgba(94, 234, 212, 0.85)",
    speaking: "rgba(255, 93, 93, 0.9)",
  };
  const quiet = "rgba(107, 115, 130, 0.35)";

  // Threshold guides — makes the VAD's decision visible, which is genuinely
  // useful when you are working out why a room is not segmenting well.
  const thresholdY = Math.min(mid - 1, perceptual(state.threshold) * mid);
  ctx.strokeStyle = "rgba(245, 181, 68, 0.22)";
  ctx.setLineDash([3, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid - thresholdY);
  ctx.lineTo(w, mid - thresholdY);
  ctx.moveTo(0, mid + thresholdY);
  ctx.lineTo(w, mid + thresholdY);
  ctx.stroke();
  ctx.setLineDash([]);

  for (let i = 0; i < count; i++) {
    const level = state.levels[i];
    const amplitude = Math.max(0.8, perceptual(level) * (mid - 2));
    const x = i * (barWidth + gap);
    const active = level > state.threshold;
    ctx.fillStyle = active ? colours[state.meterMood] || colours.idle : quiet;
    roundRect(ctx, x, mid - amplitude, barWidth, amplitude * 2, Math.min(1.5, barWidth / 2));
    ctx.fill();
  }
}

/** RMS is not perceptually linear; a cube root reads much better on a meter. */
function perceptual(level) {
  return Math.min(1, Math.cbrt(Math.max(0, level) * 12));
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
}

// ---------------------------------------------------------------------------
// Demo mode
// ---------------------------------------------------------------------------

async function toggleDemo() {
  if (state.demoRunning) return stopDemo();
  return runDemo();
}

async function runDemo() {
  if (state.editingSource) toggleSourceEditing();

  state.demoRunning = true;
  state.demoAbort = false;
  el.btnDemo.textContent = "Stop demo";
  el.btnMic.classList.add("is-listening");
  state.meterMood = "listening";

  if (state.client.remaining === 0) {
    state.doc = new SpeakdownDoc();
    state.client.reset();
    state.latencies = [];
    el.activity.innerHTML = "";
    el.activityEmpty.hidden = false;
    render();
  }

  while (state.demoRunning && !state.demoAbort && state.client.remaining > 0) {
    // Simulated speech: drive the meter for a beat so the UI behaves as it
    // does live, then fire the scripted "response".
    const utteranceIndex = DEMO_SCRIPT.length - state.client.remaining;
    const speakMs = 700 + Math.min(1600, (DEMO_SCRIPT[utteranceIndex] || "").length * 18);

    el.btnMic.classList.remove("is-listening");
    el.btnMic.classList.add("is-speaking");
    state.meterMood = "speaking";
    setStatus("Speaking", "is-speaking");
    await animateFakeLevels(speakMs);
    if (state.demoAbort) break;

    el.btnMic.classList.remove("is-speaking");
    el.btnMic.classList.add("is-listening");
    state.meterMood = "listening";
    state.currentLevel = 0;
    setStatus("Transcribing", "is-working");

    const result = await state.client.transcribe();
    if (!result || state.demoAbort) break;

    applyResult(result);
    setStatus("Demo running");
    await sleep(260);
  }

  if (state.client.remaining === 0 && !state.demoAbort) {
    toast("Demo complete — press Play to run it again", "✓");
  }
  stopDemo();
}

function stopDemo() {
  state.demoRunning = false;
  state.demoAbort = true;
  state.currentLevel = 0;
  state.meterMood = "idle";
  el.btnDemo.textContent = state.client?.remaining === 0 ? "Replay demo" : "Play demo";
  el.btnMic.classList.remove("is-listening", "is-speaking");
  setStatus("Idle");
}

async function animateFakeLevels(durationMs) {
  const started = performance.now();
  // Rough syllabic envelope: a carrier around 4 Hz with noise on top.
  while (performance.now() - started < durationMs) {
    if (state.demoAbort) break;
    const t = (performance.now() - started) / 1000;
    const envelope = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 4.2);
    state.currentLevel = 0.02 + envelope * 0.07 + Math.random() * 0.025;
    state.threshold = 0.022;
    await sleep(28);
  }
  state.currentLevel = 0;
}

// ---------------------------------------------------------------------------
// Document actions
// ---------------------------------------------------------------------------

async function copyMarkdown() {
  const markdown = currentMarkdown();
  if (!markdown.trim()) return toast("Nothing to copy", "!", "error");
  try {
    await navigator.clipboard.writeText(markdown);
    toast("Markdown copied", "✓");
  } catch {
    // Clipboard API needs a secure context; fall back to a selection copy.
    const area = document.createElement("textarea");
    area.value = markdown;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    toast("Markdown copied", "✓");
  }
}

function downloadMarkdown() {
  const markdown = currentMarkdown();
  if (!markdown.trim()) return toast("Nothing to export", "!", "error");

  const title = firstHeading(markdown) || "speakdown";
  const slug = title
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 48) || "speakdown";

  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slug}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Saved ${slug}.md`, "✓");
}

function clearDocument() {
  if (!state.doc.isEmpty() && !confirm("Clear the document? This cannot be undone by voice.")) {
    return;
  }
  const stats = { words: 0, fillersRemoved: 0, commands: 0, utterances: 0 };
  state.doc = new SpeakdownDoc();
  state.doc.stats = stats;
  state.client?.resetContext?.();
  if (state.mode === "demo") state.client.reset();
  state.latencies = [];
  el.activity.innerHTML = "";
  el.activityEmpty.hidden = false;
  el.statLatency.textContent = "—";
  el.statMedian.textContent = "—";
  el.btnDemo.textContent = "Play demo";
  if (state.editingSource) toggleSourceEditing();
  render();
}

function toggleSourceEditing() {
  state.editingSource = !state.editingSource;

  if (state.editingSource) {
    el.sourceEdit.value = state.doc.toMarkdown();
    el.sourceEdit.hidden = false;
    el.source.hidden = true;
    el.emptyState.hidden = true;
    el.btnEditSource.textContent = "Done";
    el.sourceEdit.focus();
  } else {
    // Re-parse the hand-edited markdown, carrying confidence and counters over.
    const confidence = state.doc.confidence;
    const stats = state.doc.stats;
    state.doc = SpeakdownDoc.fromMarkdown(el.sourceEdit.value);
    state.doc.confidence = confidence;
    state.doc.stats = stats;
    el.sourceEdit.hidden = true;
    el.source.hidden = false;
    el.btnEditSource.textContent = "Edit";
    render();
  }
}

function currentMarkdown() {
  return state.editingSource ? el.sourceEdit.value : state.doc.toMarkdown();
}

function firstHeading(markdown) {
  const m = markdown.match(/^#\s+(.+)$/m) || markdown.match(/^##\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Chrome helpers
// ---------------------------------------------------------------------------

function showBanner(text, isError = false) {
  el.bannerText.textContent = text;
  el.banner.classList.toggle("is-error", isError);
  el.banner.hidden = false;
}

function toast(message, icon = "▸", variant = "") {
  const node = document.createElement("div");
  node.className = `toast ${variant === "error" ? "is-error" : ""}`.trim();
  node.innerHTML = `<span class="toast-icon">${escapeHtmlText(icon)}</span><span>${escapeHtmlText(message)}</span>`;
  el.toasts.append(node);

  setTimeout(() => {
    node.classList.add("is-out");
    setTimeout(() => node.remove(), 240);
  }, 1500);

  while (el.toasts.children.length > 4) el.toasts.firstElementChild.remove();
}

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

const SETTINGS_KEY = "speakdown.settings.v1";

function persistSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    /* private window, or storage disabled — settings simply do not persist */
  }
}

function restoreSettings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
  } catch {
    saved = null;
  }
  if (saved && typeof saved === "object") Object.assign(state.settings, saved);

  el.fillerLevel.value = state.settings.fillerLevel;
  el.captureMode.value = state.settings.captureMode;
  el.togglePunctuation.checked = !!state.settings.punctuation;
  el.toggleHeatmap.checked = !!state.settings.heatmap;
  el.toggleAutoscroll.checked = !!state.settings.autoscroll;
  el.app.classList.toggle("no-heatmap", !state.settings.heatmap);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function escapeHtmlText(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function escapeAttr(text) {
  return escapeHtmlText(text).replace(/\n/g, " ");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
