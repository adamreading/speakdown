/**
 * Speakdown — application wiring.
 *
 * Life of one utterance:
 *
 *   VAD detects speech onset
 *     -> POST /api/dictate/start          (upstream request opens NOW)
 *     -> PCM frames stream up every ~120 ms while the person is still talking
 *   VAD detects ~700 ms of silence
 *     -> POST /api/dictate/end            (body closes, transcript comes back)
 *     -> pick cleaned or verbatim text
 *     -> parse commands -> apply to document -> render
 *
 * Three things here are less obvious than they look:
 *
 * Audio can arrive before the session exists. `start` is a network round trip,
 * short as it is, and the microphone does not wait for it. Frames captured in
 * that window are buffered and flushed the moment the session id lands, rather
 * than dropped — losing them would clip the first word of every utterance and
 * undo the whole point of the pre-roll.
 *
 * Utterances overlap, so they are applied in spoken order. A sequence number
 * and a pending map keep the document in the order the words were said, even
 * when a short clip's transcript returns before a longer earlier one's.
 *
 * Every transcript is kept. The Cleaned/Verbatim toggle rebuilds the whole
 * document by replaying the log through the same deterministic pipeline, so
 * switching views is exact rather than an approximation applied after the fact.
 */

import { Recorder, RecorderState } from "./recorder.js";
import { LiveDictation, DemoDictation, DEMO_SCRIPT } from "./dictation.js";
import { SpeakdownDoc } from "./doc.js";
import { commandGroups, KEYTERMS } from "./commands.js";
import { applyTranscript } from "./pipeline.js";
import { wordCount } from "./text.js";
import { renderMarkdown, highlightSource, escapeHtml } from "./markdown.js";

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

  /** Every API response, in spoken order. The toggle replays these. */
  transcripts: [],
  textSource: "cleaned", // 'cleaned' | 'verbatim'

  settings: {
    language: "en",
    uploadMode: "streaming",
    captureMode: "vad",
    fillerLevel: "off",
    llmInstruction: "",
    punctuation: false,
    heatmap: true,
    autoscroll: true,
  },

  waits: [],
  streamedBytes: 0,
  levels: new Array(110).fill(0),
  threshold: 0.01,
  currentLevel: 0,
  meterMood: "idle",

  // Current utterance
  utterance: null,
  utterancePromise: null,
  pendingPcm: [],
  activeSeq: -1,

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
    state.config = await (await fetch("/api/config")).json();
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
    "commandList", "activity", "activityEmpty", "sourceToggle",
    "uploadMode", "captureMode", "fillerLevel", "llmInstruction",
    "togglePunctuation", "toggleHeatmap", "toggleAutoscroll", "btnEditSource",
    "metaEndpoint", "metaAudio", "metaKeyterms", "metaLlm",
    "btnMic", "btnDemo", "meter", "status", "statusHint",
    "statWait", "statMedian", "statStreamed", "statWords", "statCommands",
    "toasts",
  ];
  for (const id of ids) el[id] = document.getElementById(id);
  el.railTabs = [...document.querySelectorAll(".rail-tab")];
  el.segButtons = [...el.sourceToggle.querySelectorAll(".seg")];
  el.meterCtx = el.meter.getContext("2d");
}

function applyModeChrome() {
  const live = state.mode === "live";
  el.modePill.classList.toggle("is-live", live);
  el.modePill.classList.toggle("is-demo", !live);
  el.modeLabel.textContent = live ? "Live" : "Demo";
  el.modePill.title = live
    ? "Connected to the AssemblyAI Dictation API"
    : "No API key configured — replaying a scripted document";

  el.btnDemo.hidden = live;
  el.metaEndpoint.textContent = state.config?.endpoint || "dictation.assemblyai.com/v1/transcribe/live";
  el.metaKeyterms.textContent = `${KEYTERMS.length} phrases, every request`;
  updateMetaFromSettings();

  if (!live) {
    showBanner(
      "Demo Mode — no API key set, so this replays a scripted document with simulated " +
        "timings. Add ASSEMBLYAI_API_KEY to .env and restart for real dictation.",
    );
    el.statusHint.textContent = "Press Play demo to watch it build a document";
  }
}

function updateMetaFromSettings() {
  const streaming = state.settings.uploadMode === "streaming";
  el.metaAudio.textContent = streaming
    ? "16 kHz mono PCM, streamed while speaking"
    : "16 kHz mono WAV, sent after speaking";
  el.metaLlm.textContent = state.settings.llmInstruction.trim()
    ? "custom — replaces default cleanup"
    : "omitted — default cleanup";
}

function populateLanguages() {
  const languages = state.config?.languages || [{ code: "en", label: "English" }];
  el.language.innerHTML = languages.map((l) => `<option value="${l.code}">${l.label}</option>`).join("");
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
            const phrase = cmd.phrases[0] || cmd.strictPhrases?.[0] || cmd.id;
            const alt = [...(cmd.phrases || []), ...(cmd.strictPhrases || [])].slice(1);
            const title = alt.length ? ` title="also: ${escapeHtml(alt.join(", "))}"` : "";
            return `
              <div class="cmd" data-command="${cmd.id}"${title}>
                <span class="cmd-phrase">“${escapeHtml(phrase)}”</span>
                ${cmd.hint ? `<span class="cmd-hint">${escapeHtml(cmd.hint)}</span>` : ""}
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
    void node.offsetWidth; // restart the animation on a repeated command
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

  for (const seg of el.segButtons) {
    seg.addEventListener("click", () => setTextSource(seg.dataset.source));
  }

  el.language.addEventListener("change", () => {
    state.settings.language = el.language.value;
    persistSettings();
  });

  el.uploadMode.addEventListener("change", () => {
    state.settings.uploadMode = el.uploadMode.value;
    if (state.recorder) state.recorder.keepWav = state.settings.uploadMode === "buffered";
    updateMetaFromSettings();
    persistSettings();
  });

  el.captureMode.addEventListener("change", () => {
    state.settings.captureMode = el.captureMode.value;
    state.recorder?.setMode(state.settings.captureMode);
    updateStatus();
    persistSettings();
  });

  el.fillerLevel.addEventListener("change", () => {
    state.settings.fillerLevel = el.fillerLevel.value;
    rebuildDocument();
    persistSettings();
  });

  el.llmInstruction.addEventListener("change", () => {
    state.settings.llmInstruction = el.llmInstruction.value;
    updateMetaFromSettings();
    persistSettings();
  });

  el.togglePunctuation.addEventListener("change", () => {
    state.settings.punctuation = el.togglePunctuation.checked;
    rebuildDocument();
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

  for (const tab of el.railTabs) tab.addEventListener("click", () => selectTab(tab.dataset.tab));

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
    return toggleDictation();
  }
  if (meta && event.key.toLowerCase() === "s") {
    event.preventDefault();
    return downloadMarkdown();
  }
  if (meta && event.shiftKey && event.key.toLowerCase() === "c") {
    event.preventDefault();
    return copyMarkdown();
  }
  if (typing) return;

  if (event.code === "Space" && state.settings.captureMode === "ptt" && state.running && !event.repeat) {
    event.preventDefault();
    state.recorder?.pttDown();
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
// Cleaned / verbatim
// ---------------------------------------------------------------------------

function setTextSource(source) {
  if (source !== "cleaned" && source !== "verbatim") return;
  if (state.textSource === source) return;
  state.textSource = source;

  for (const seg of el.segButtons) seg.classList.toggle("is-active", seg.dataset.source === source);
  el.app.classList.toggle("is-verbatim", source === "verbatim");

  rebuildDocument();
  toast(source === "cleaned" ? "Showing llm_response" : "Showing raw transcript", "▸");
}

/** Which text this response contributes, given the current view. */
function textFor(result) {
  if (state.textSource === "verbatim") return result.text || "";
  // Rewrites are best-effort: a null llm_response with a non-null llm_error is
  // a successful transcription whose rewrite failed, so fall back to verbatim.
  return result.llm_response || result.text || "";
}

/**
 * Replay every stored transcript through the pipeline.
 * The pipeline is deterministic, so this is an exact reconstruction rather than
 * an edit applied on top of the existing document.
 */
function rebuildDocument() {
  const confidence = state.doc.confidence;
  state.doc = new SpeakdownDoc();
  state.doc.confidence = confidence;

  for (const result of state.transcripts) {
    applyTranscript(state.doc, textFor(result), {
      fillerLevel: state.settings.fillerLevel,
      punctuation: state.settings.punctuation,
    });
  }
  render();
}

// ---------------------------------------------------------------------------
// Dictation lifecycle
// ---------------------------------------------------------------------------

async function toggleDictation() {
  if (state.mode === "demo") {
    toast("Demo Mode — add an API key for live dictation", "!", "error");
    return;
  }
  return state.running ? stopDictation() : startDictation();
}

async function startDictation() {
  if (state.editingSource) toggleSourceEditing();

  state.recorder = new Recorder({
    onSpeechStart: handleSpeechStart,
    onAudio: handleAudio,
    onSpeechEnd: handleSpeechEnd,
    onLevel: (level, threshold) => {
      state.currentLevel = level;
      state.threshold = threshold;
    },
    onState: onRecorderState,
  });
  state.recorder.setMode(state.settings.captureMode);
  state.recorder.keepWav = state.settings.uploadMode === "buffered";

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
  await state.utterance?.abort?.();
  state.utterance = null;
  state.pendingPcm = [];
  state.meterMood = "idle";
  el.btnMic.classList.remove("is-listening", "is-speaking");
  el.btnMic.setAttribute("aria-label", "Start dictation");
  setStatus("Idle");
  el.statusHint.textContent =
    state.settings.captureMode === "ptt"
      ? "Push to talk — hold Space while the mic is on"
      : "Press the mic, or hit ⌘/Ctrl + Enter";
}

/**
 * Speech detected. Open the upstream request immediately — this is the call
 * that lets transcription overlap with the rest of the utterance.
 */
function handleSpeechStart() {
  if (state.settings.uploadMode === "buffered") return; // nothing opens early

  state.activeSeq = state.seq++;
  state.pendingPcm = [];
  state.utterance = null;

  state.utterancePromise = state.client
    .startUtterance({
      language: state.settings.language,
      llmInstruction: state.settings.llmInstruction,
    })
    .then((utterance) => {
      state.utterance = utterance;
      // The microphone did not wait for this round trip. Flush what it captured.
      for (const pcm of state.pendingPcm) utterance.send(pcm);
      state.pendingPcm = [];
      return utterance;
    })
    .catch((err) => {
      reportTranscriptionError(err);
      return null;
    });
}

function handleAudio(pcmBytes) {
  if (state.settings.uploadMode === "buffered") return;
  state.streamedBytes += pcmBytes.length;
  if (state.utterance) state.utterance.send(pcmBytes);
  else state.pendingPcm.push(pcmBytes);
}

async function handleSpeechEnd(info) {
  if (state.settings.uploadMode === "buffered") {
    if (info.tooShort || !info.wav) return;
    const seq = state.seq++;
    return awaitResult(seq, () =>
      state.client.transcribeBuffered(info.wav.blob, {
        language: state.settings.language,
        llmInstruction: state.settings.llmInstruction,
      }),
    );
  }

  const seq = state.activeSeq;
  const utterance = await state.utterancePromise;
  state.utterance = null;
  state.pendingPcm = [];
  if (!utterance) return;

  if (info.tooShort) {
    // A cough or a door. Close the session without spending a transcription.
    await utterance.abort();
    return;
  }

  return awaitResult(seq, () => utterance.end());
}

/** Run a request, keeping application in spoken order. */
async function awaitResult(seq, run) {
  state.inFlight++;
  updateStatus();
  try {
    const result = await run();
    if (result) state.pending.set(seq, { result });
  } catch (err) {
    state.pending.set(seq, { error: err });
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

function onRecorderState(recState, detail) {
  if (recState === RecorderState.SPEAKING) {
    el.btnMic.classList.remove("is-listening");
    el.btnMic.classList.add("is-speaking");
    state.meterMood = "speaking";
    setStatus("Speaking", "is-speaking");
    el.statusHint.textContent =
      state.settings.uploadMode === "streaming"
        ? "Uploading as you speak"
        : "Buffering — will send when you pause";
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
    el.statusHint.textContent = "Waiting on the tail";
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
// Applying a transcript
// ---------------------------------------------------------------------------

function applyResult(result) {
  const chosen = textFor(result);
  if (!chosen.trim()) return;

  state.transcripts.push(result);
  state.doc.recordWords(result.words);

  const report = applyTranscript(state.doc, chosen, {
    fillerLevel: state.settings.fillerLevel,
    punctuation: state.settings.punctuation,
  });

  for (const cmd of report.commands) flashCommand(cmd);
  for (const warning of report.warnings) toast(warning, "!", "error");

  if (report.control === "stop") {
    if (state.demoRunning) stopDemo();
    else stopDictation();
  }

  if (result.llm_error) {
    toast(`Rewrite ${result.llm_error} — using verbatim`, "!", "error");
  }

  logActivity(result, report);
  recordTimings(result);
  render();
}

function reportTranscriptionError(err) {
  logActivityError(err);

  if (err.fatal || err.code === "invalid_api_key" || err.code === "no_api_key") {
    showBanner(err.message, true);
    stopDictation();
    return;
  }
  if (err.status === 429) {
    showBanner(
      `Rate limited by AssemblyAI${err.retryAfter ? ` — retry after ${err.retryAfter}s` : ""}. ` +
        "Speak in longer stretches to send fewer, larger clips.",
      true,
    );
    return;
  }
  if (err.code === "audio_too_short") return; // routine
  toast(err.message || "Transcription failed", "!", "error");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  const markdown = state.doc.toMarkdown();
  const lowConfidence = new Set(state.doc.lowConfidenceTerms(0.75).map((e) => e.word));

  if (!state.editingSource) {
    el.source.innerHTML = highlightSource(markdown, lowConfidence);
  }
  el.preview.innerHTML = renderMarkdown(markdown);
  el.emptyState.hidden = !state.doc.isEmpty();

  const words = wordCount(markdown.replace(/[#>`*_~\-[\]()]/g, " "));
  el.docStats.textContent = `${words} word${words === 1 ? "" : "s"}`;
  el.statWords.textContent = String(words);
  el.statCommands.textContent = String(state.doc.stats.commands);

  if (state.settings.autoscroll) {
    requestAnimationFrame(() => {
      for (const pane of [el.source.parentElement, el.preview.parentElement]) {
        if (pane) pane.scrollTop = pane.scrollHeight;
      }
    });
  }
}

function recordTimings(result) {
  const wait = result._speakdown?.waitAfterSpeechMs;
  if (typeof wait === "number") {
    state.waits.push(wait);
    if (state.waits.length > 500) state.waits.shift();
    el.statWait.textContent = `${wait}ms`;

    const sorted = [...state.waits].sort((a, b) => a - b);
    el.statMedian.textContent = `${sorted[Math.floor(sorted.length / 2)]}ms`;
  }

  el.statWait.parentElement.title =
    `server ${result.request_time_ms ?? "?"}ms ` +
    `(transcribe ${result.sync_time_ms ?? "?"}ms + rewrite ${result._speakdown?.rewriteMs ?? "?"}ms)`;

  const streaming = result._speakdown?.mode === "streaming";
  el.statStreamed.parentElement.classList.toggle("stat-muted", !streaming);
  if (streaming && result._speakdown?.uploadHeldMs != null) {
    el.statStreamed.textContent = `${(result._speakdown.uploadHeldMs / 1000).toFixed(1)}s`;
  } else {
    el.statStreamed.textContent = streaming ? "—" : "off";
  }
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

function logActivity(result, report) {
  el.activityEmpty.hidden = true;

  const sd = result._speakdown || {};
  const wait = sd.waitAfterSpeechMs ?? result.request_time_ms ?? 0;

  const chips = [
    `<span class="chip ${wait <= 400 ? "chip-fast" : "chip-slow"}">${wait}ms wait</span>`,
    sd.mode === "streaming"
      ? `<span class="chip chip-stream">streamed${sd.chunks ? ` ${sd.chunks}×` : ""}</span>`
      : `<span class="chip">buffered</span>`,
    result.sync_time_ms != null ? `<span class="chip">stt ${result.sync_time_ms}ms</span>` : "",
    sd.rewriteMs != null ? `<span class="chip chip-rewrite">rewrite ${sd.rewriteMs}ms</span>` : "",
    typeof result.confidence === "number"
      ? `<span class="chip">conf ${(result.confidence * 100).toFixed(0)}%</span>`
      : "",
    result.audio_duration_ms
      ? `<span class="chip">${(result.audio_duration_ms / 1000).toFixed(1)}s audio</span>`
      : "",
    report.commands.length ? `<span class="chip chip-cmd">${report.commands.length} cmd</span>` : "",
    result.llm_error ? `<span class="chip chip-err">rewrite ${result.llm_error}</span>` : "",
  ]
    .filter(Boolean)
    .join("");

  const item = document.createElement("li");
  item.className = "act";
  item.innerHTML =
    `<p class="act-text">${escapeHtml(textFor(result))}</p>` +
    rewriteDiffHtml(result) +
    `<div class="act-meta">${chips}</div>`;
  el.activity.prepend(item);

  while (el.activity.children.length > 40) el.activity.lastElementChild.remove();
}

/**
 * Show what the rewrite removed, when it removed anything.
 *
 * The default cleanup only deletes words, so a word-level diff that marks
 * deletions is an accurate picture of it rather than an approximation.
 */
function rewriteDiffHtml(result) {
  const verbatim = (result.text || "").trim();
  const cleaned = (result.llm_response || "").trim();
  if (!verbatim || !cleaned || verbatim === cleaned) return "";

  const before = verbatim.split(/\s+/);
  const after = cleaned.split(/\s+/);
  const parts = [];
  let i = 0;
  let j = 0;
  let removed = 0;

  while (i < before.length) {
    const a = before[i];
    const b = after[j];
    if (b !== undefined && a.toLowerCase() === b.toLowerCase()) {
      parts.push(escapeHtml(a));
      i++;
      j++;
    } else {
      parts.push(`<del>${escapeHtml(a)}</del>`);
      removed++;
      i++;
    }
  }
  if (!removed) return "";

  return (
    `<div class="act-diff"><span class="act-diff-label">rewrite removed ${removed} word${removed === 1 ? "" : "s"}</span>` +
    `${parts.join(" ")}</div>`
  );
}

function logActivityError(err) {
  el.activityEmpty.hidden = true;
  const item = document.createElement("li");
  item.className = "act";
  item.innerHTML =
    `<p class="act-text">${escapeHtml(err.message || "Request failed")}</p>` +
    `<div class="act-meta"><span class="chip chip-err">${escapeHtml(err.code || "error")}</span></div>`;
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
  const dpr = window.devicePixelRatio || 1;
  const w = el.meter.width / dpr;
  const h = el.meter.height / dpr;
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

  // Threshold guides make the VAD's decision visible, which is genuinely useful
  // when working out why a room is not segmenting well.
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
    ctx.fillStyle = level > state.threshold
      ? colours[state.meterMood] || colours.idle
      : "rgba(107, 115, 130, 0.35)";
    roundRect(ctx, i * (barWidth + gap), mid - amplitude, barWidth, amplitude * 2, Math.min(1.5, barWidth / 2));
    ctx.fill();
  }
}

/** RMS is not perceptually linear; a cube root reads much better on a meter. */
function perceptual(level) {
  return Math.min(1, Math.cbrt(Math.max(0, level) * 12));
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

// ---------------------------------------------------------------------------
// Demo mode
// ---------------------------------------------------------------------------

async function toggleDemo() {
  return state.demoRunning ? stopDemo() : runDemo();
}

async function runDemo() {
  if (state.editingSource) toggleSourceEditing();

  state.demoRunning = true;
  state.demoAbort = false;
  el.btnDemo.textContent = "Stop demo";
  el.btnMic.classList.add("is-listening");
  state.meterMood = "listening";

  if (state.client.remaining === 0) resetSession();

  while (state.demoRunning && !state.demoAbort && state.client.remaining > 0) {
    const entry = DEMO_SCRIPT[DEMO_SCRIPT.length - state.client.remaining];
    const speakMs = 700 + Math.min(1600, (entry?.text || "").length * 16);

    const utterance = await state.client.startUtterance();

    el.btnMic.classList.remove("is-listening");
    el.btnMic.classList.add("is-speaking");
    state.meterMood = "speaking";
    setStatus("Speaking", "is-speaking");
    el.statusHint.textContent = "Uploading as you speak";
    await animateFakeLevels(speakMs);
    if (state.demoAbort) break;

    el.btnMic.classList.remove("is-speaking");
    el.btnMic.classList.add("is-listening");
    state.meterMood = "listening";
    state.currentLevel = 0;
    setStatus("Transcribing", "is-working");

    const result = await utterance.end();
    if (!result || state.demoAbort) break;

    applyResult(result);
    setStatus("Demo running");
    await sleep(240);
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
    const area = document.createElement("textarea");
    area.value = markdown;
    area.style.cssText = "position:fixed;opacity:0";
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

  const slug =
    (firstHeading(markdown) || "speakdown")
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

function resetSession() {
  state.doc = new SpeakdownDoc();
  state.transcripts = [];
  state.waits = [];
  state.streamedBytes = 0;
  state.seq = 0;
  state.nextToApply = 0;
  state.pending.clear();
  if (state.mode === "demo") state.client.reset();
  el.activity.innerHTML = "";
  el.activityEmpty.hidden = false;
  el.statWait.textContent = "—";
  el.statMedian.textContent = "—";
  el.statStreamed.textContent = "—";
  el.btnDemo.textContent = "Play demo";
}

function clearDocument() {
  if (!state.doc.isEmpty() && !confirm("Clear the document? This cannot be undone by voice.")) return;
  if (state.editingSource) toggleSourceEditing();
  resetSession();
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
    // A hand edit becomes the document. The transcript log no longer describes
    // it, so it is dropped rather than left to silently revert the edit on the
    // next Cleaned/Verbatim toggle.
    const confidence = state.doc.confidence;
    const stats = state.doc.stats;
    state.doc = SpeakdownDoc.fromMarkdown(el.sourceEdit.value);
    state.doc.confidence = confidence;
    state.doc.stats = stats;
    state.transcripts = [];
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
  node.innerHTML = `<span class="toast-icon">${escapeHtml(icon)}</span><span>${escapeHtml(message)}</span>`;
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

const SETTINGS_KEY = "speakdown.settings.v2";

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

  el.uploadMode.value = state.settings.uploadMode;
  el.captureMode.value = state.settings.captureMode;
  el.fillerLevel.value = state.settings.fillerLevel;
  el.llmInstruction.value = state.settings.llmInstruction || "";
  el.togglePunctuation.checked = !!state.settings.punctuation;
  el.toggleHeatmap.checked = !!state.settings.heatmap;
  el.toggleAutoscroll.checked = !!state.settings.autoscroll;
  el.app.classList.toggle("no-heatmap", !state.settings.heatmap);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
