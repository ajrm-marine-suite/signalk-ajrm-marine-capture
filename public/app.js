/**
 * Browser entry point for AJRM Marine Voyages; binds operator controls and renders server state.
 */

const API = "/plugins/signalk-ajrm-marine-capture";

const elements = {
  banner: document.getElementById("banner"),
  refreshButton: document.getElementById("refreshButton"),
  enabledToggle: document.getElementById("enabledToggle"),
  recordOutputsToggle: document.getElementById("recordOutputsToggle"),
  stateValue: document.getElementById("stateValue"),
  voyageValue: document.getElementById("voyageValue"),
  speedValue: document.getElementById("speedValue"),
  thresholdValue: document.getElementById("thresholdValue"),
  modeValue: document.getElementById("modeValue"),
  captureValue: document.getElementById("captureValue"),
  snapshotValue: document.getElementById("snapshotValue"),
  diskValue: document.getElementById("diskValue"),
  bundleValue: document.getElementById("bundleValue"),
  indexValue: document.getElementById("indexValue"),
  eventValue: document.getElementById("eventValue"),
  events: document.getElementById("events"),
  voyageBundles: document.getElementById("voyageBundles"),
  downloadSelectedBundle: document.getElementById("downloadSelectedBundle"),
  deleteSelectedBundle: document.getElementById("deleteSelectedBundle"),
  selectedBundleInfo: document.getElementById("selectedBundleInfo"),
  startButton: document.getElementById("startButton"),
  stopButton: document.getElementById("stopButton"),
  useSavedResultsToggle: document.getElementById("useSavedResultsToggle"),
  recaptureToggle: document.getElementById("recaptureToggle"),
  rewindPlaybackButton: document.getElementById("rewindPlaybackButton"),
  backPlaybackButton: document.getElementById("backPlaybackButton"),
  playPlaybackButton: document.getElementById("playPlaybackButton"),
  pausePlaybackButton: document.getElementById("pausePlaybackButton"),
  stopPlaybackButton: document.getElementById("stopPlaybackButton"),
  forwardPlaybackButton: document.getElementById("forwardPlaybackButton"),
  replayCaptureInfo: document.getElementById("replayCaptureInfo"),
  replayPlaybackState: document.getElementById("replayPlaybackState"),
  replayProgressValue: document.getElementById("replayProgressValue"),
  replayProgressBar: document.getElementById("replayProgressBar"),
  replaySegmentsValue: document.getElementById("replaySegmentsValue"),
  replayFinaliseValue: document.getElementById("replayFinaliseValue"),
  replayFinaliseProgressBar: document.getElementById("replayFinaliseProgressBar"),
  commentInput: document.getElementById("commentInput"),
  saveCommentButton: document.getElementById("saveCommentButton"),
};

let selectedBundle = null;
let pendingRecorderAction = null;
let recorderActionLatch = null;
let pendingReplayAction = null;
let replayPlayLatch = false;
let latestStatus = null;
let refreshSequence = 0;
let appliedRefreshSequence = 0;

elements.refreshButton.addEventListener("click", refresh);
elements.enabledToggle.addEventListener("change", () =>
  command("/settings", { enabled: elements.enabledToggle.checked }),
);
elements.recordOutputsToggle.addEventListener("change", () =>
  command("/settings", { recordOutputs: elements.recordOutputsToggle.checked }),
);
elements.startButton.addEventListener("click", () => recorderCommand("start", "/voyage/start", {
  manual: true,
  comment: elements.commentInput.value,
}));
elements.stopButton.addEventListener("click", () => recorderCommand("stop", "/voyage/stop", { manual: true }));
elements.playPlaybackButton.addEventListener("click", () => {
  if (latestStatus?.playback?.paused === true) {
    replayRecorderCommand("resume", "/voyage/player/resume", {});
    return;
  }
  replayRecorderCommand("play", "/voyage/player/play", {
    file: selectedBundle && selectedBundle.fileName,
    useSavedResults: elements.useSavedResultsToggle.checked,
    recapture: elements.recaptureToggle.checked,
    comment: elements.commentInput.value,
  });
});
elements.pausePlaybackButton.addEventListener("click", () =>
  replayRecorderCommand("pause", "/voyage/player/pause", {}),
);
elements.stopPlaybackButton.addEventListener("click", () =>
  replayRecorderCommand("stop", "/voyage/playback/stop", {}),
);
elements.rewindPlaybackButton.addEventListener("click", () =>
  replayRecorderCommand("rewind", "/voyage/player/rewind", {}),
);
elements.backPlaybackButton.addEventListener("click", () =>
  seekPlayback(-300_000),
);
elements.forwardPlaybackButton.addEventListener("click", () =>
  seekPlayback(300_000),
);
elements.recaptureToggle.addEventListener("change", () => {
  if (elements.recaptureToggle.checked) elements.useSavedResultsToggle.checked = false;
  if (latestStatus) renderReplayRecorder(latestStatus);
});
elements.saveCommentButton.addEventListener("click", () =>
  command("/voyage/comment", { comment: elements.commentInput.value }),
);
elements.deleteSelectedBundle.addEventListener("click", () => {
  if (selectedBundle) deleteVoyage(selectedBundle.fileName);
});
elements.downloadSelectedBundle.addEventListener("click", (event) => {
  if (elements.downloadSelectedBundle.classList.contains("disabled")) {
    event.preventDefault();
    return;
  }
  if (!selectedBundle?.downloadUrl) {
    event.preventDefault();
    return;
  }
  elements.banner.classList.remove("error");
  elements.banner.textContent =
    `Preparing ${selectedBundle.fileName}. The browser will stream the ZIP directly when it is ready.`;
});

refresh();
setInterval(refresh, 5000);

async function refresh() {
  const sequence = ++refreshSequence;
  try {
    const response = await fetch(`${API}/status`, { cache: "no-store" });
    const status = await response.json();
    if (!response.ok || !status.ok) throw new Error(status.error || "Status failed");
    if (sequence < appliedRefreshSequence) return;
    appliedRefreshSequence = sequence;
    latestStatus = status;
    render(status);
  } catch (error) {
    if (sequence < appliedRefreshSequence) return;
    appliedRefreshSequence = sequence;
    elements.banner.textContent = error.message || String(error);
    elements.banner.classList.add("error");
  }
}

async function command(path, body) {
  elements.banner.textContent = "Working...";
  elements.banner.classList.remove("error");
  try {
    const response = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      throw new Error(result.error || `Command failed: HTTP ${response.status}`);
    }
    await refresh();
    return true;
  } catch (error) {
    elements.banner.textContent = error.message || "Command failed";
    elements.banner.classList.add("error");
    return false;
  }
}

async function recorderCommand(action, path, body) {
  pendingRecorderAction = action;
  renderRecorderButtons({ currentVoyage: action === "stop" ? true : null });
  try {
    const ok = await command(path, body);
    recorderActionLatch = ok ? action : null;
  } finally {
    pendingRecorderAction = null;
    renderRecorderButtons(latestStatus || {});
  }
}

function render(status) {
  elements.banner.textContent = status.enabled
    ? "Automatic voyage recording is enabled."
    : "Automatic voyage recording is disabled.";
  elements.enabledToggle.checked = status.enabled === true;
  elements.recordOutputsToggle.checked = status.recordOutputs === true;
  elements.recordOutputsToggle.disabled = Boolean(status.currentVoyage);
  elements.stateValue.textContent = status.state || "-";
  elements.voyageValue.textContent = status.currentVoyage
    ? `${status.currentVoyage.id} since ${formatTime(status.currentVoyage.startedAt)}`
    : "-";
  if (document.activeElement !== elements.commentInput) {
    elements.commentInput.value = status.voyageComment || "";
  }
  elements.speedValue.textContent = Number.isFinite(status.speedKnots)
    ? `${status.speedKnots.toFixed(1)} kn`
    : "-";
  elements.thresholdValue.textContent = status.thresholds
    ? `${Number(status.thresholds.movementSpeedKnots || 0).toFixed(2)} kn / ${Number(status.thresholds.movementSpeedMetersPerSecond || 0).toFixed(2)} m/s`
    : "-";
  elements.modeValue.textContent = titleCase(status.captureMode || "voyage");
  elements.captureValue.textContent = status.currentVoyage?.recomputedReplay
    ? "recapturing inputs + fresh results"
    : status.currentVoyage
      ? status.currentVoyage.recomputedOutput
        ? "recording sensor inputs + calculated results"
        : "recording sensor inputs"
      : "idle";
  elements.snapshotValue.textContent = status.currentVoyage
    ? `${status.currentVoyage.snapshotCount || 0}`
    : "-";
  elements.diskValue.textContent = status.disk
    ? `${formatBytes(status.disk.availableBytes)} free (${status.disk.usedPercent || 0}% used)`
    : "-";
  elements.bundleValue.textContent = status.lastBundle && status.lastBundle.fileName || "-";
  elements.indexValue.textContent = status.lastBundle && status.lastBundle.indexFile || "-";
  const recent = status.recentEvents || [];
  elements.eventValue.textContent = recent[0] ? `${formatTime(recent[0].at)} ${recent[0].message}` : "-";
  elements.events.innerHTML = recent
    .map((event) => `<li><strong>${escapeHtml(formatTime(event.at))}</strong> ${escapeHtml(event.type)} — ${escapeHtml(event.message)}</li>`)
    .join("");
  renderVoyageBundles(status.voyages || []);
  renderRecorderButtons(status);
  renderReplayRecorder(status);
}

function renderRecorderButtons(status) {
  const activeVoyage = status.currentVoyage === null ? null : Boolean(status.currentVoyage);
  const recomputedActive = Boolean(
    status.currentVoyage && status.currentVoyage.recomputedReplay,
  );
  if (recorderActionLatch === "start" && activeVoyage === true) recorderActionLatch = null;
  if (recorderActionLatch === "stop" && activeVoyage === false) recorderActionLatch = null;
  const busy = pendingRecorderAction === "start" || pendingRecorderAction === "stop";
  const playbackBusy = status.playback?.active === true ||
    Boolean(status.playerTransition) ||
    ["preparing", "ready", "seeking"].includes(status.playback?.state);
  elements.startButton.disabled = busy || recorderActionLatch === "start" || activeVoyage === true || playbackBusy;
  elements.stopButton.disabled =
    busy ||
    recorderActionLatch === "stop" ||
    activeVoyage === false ||
    recomputedActive;
  elements.startButton.textContent = pendingRecorderAction === "start" ? "Starting..." : "Start now";
  elements.stopButton.textContent = pendingRecorderAction === "stop" ? "Stopping..." : "Stop now";
}

async function replayRecorderCommand(action, path, body) {
  pendingReplayAction = action;
  renderReplayRecorder(latestStatus || {});
  try {
    const ok = await command(path, body);
    if (action === "play") replayPlayLatch = ok;
  } finally {
    pendingReplayAction = null;
    renderReplayRecorder(latestStatus || {});
  }
}

function seekPlayback(offsetMs) {
  const current = Number(latestStatus?.playback?.sourceElapsedMs) || 0;
  const duration = Number(latestStatus?.playback?.sourceDurationMs) || 0;
  const positionMs = Math.max(0, Math.min(duration, current + offsetMs));
  replayRecorderCommand("seek", "/voyage/player/seek", { positionMs });
}

function renderReplayRecorder(status) {
  const playback = status.playback || {};
  const currentVoyage = status.currentVoyage || null;
  const recaptureActive = Boolean(currentVoyage && currentVoyage.recomputedReplay);
  const playbackActive = playback.active === true;
  const playbackPaused = playback.paused === true;
  const serverTransitioning = Boolean(status.playerTransition) ||
    ["preparing", "ready", "seeking"].includes(playback.state);
  if (
    replayPlayLatch &&
    (playbackActive || ["complete", "failed", "aborted"].includes(playback.state))
  ) {
    replayPlayLatch = false;
  }
  const selectedReady = selectedBundle?.hasInputs === true ||
    selectedBundle?.canonicalInput?.contract === status.canonicalInputContract;
  const selectedRecordedResult = selectedBundle?.hasSavedResults === true ||
    (selectedBundle?.recomputedOutput?.contract === status.recomputedOutputContract &&
      selectedBundle.recomputedOutput.complete === true &&
      Number(selectedBundle.recomputedOutput.records) > 0);
  const replayFinished =
    playback.state === "complete" &&
    playback.complete === true &&
    playback.valid === true;
  const finalisationRunning = status.finalisation?.state === "running";
  const playbackPreparing = !playbackActive && (
    pendingReplayAction === "play" ||
    pendingReplayAction === "seek" ||
    replayPlayLatch ||
    Boolean(status.playerTransition) ||
    playback.state === "preparing" ||
    playback.state === "seeking"
  );
  const playbackSeeking = pendingReplayAction === "seek" || playback.state === "seeking";
  const busy = replayPlayLatch ||
    pendingReplayAction === "play" ||
    pendingReplayAction === "pause" ||
    pendingReplayAction === "resume" ||
    pendingReplayAction === "stop" ||
    pendingReplayAction === "rewind" ||
    pendingReplayAction === "seek";
  const controlsBusy = busy || serverTransitioning;
  if (!selectedRecordedResult) elements.useSavedResultsToggle.checked = false;
  if (elements.recaptureToggle.checked) elements.useSavedResultsToggle.checked = false;
  elements.useSavedResultsToggle.disabled =
    controlsBusy || playbackActive || finalisationRunning || !selectedRecordedResult ||
    elements.recaptureToggle.checked;
  elements.recaptureToggle.disabled =
    controlsBusy || playbackActive || finalisationRunning || !selectedReady;
  elements.playPlaybackButton.disabled = controlsBusy || finalisationRunning ||
    (playbackActive ? !playbackPaused : !selectedReady && !selectedRecordedResult) ||
    Boolean(currentVoyage && !recaptureActive);
  elements.pausePlaybackButton.disabled = controlsBusy || !playbackActive || playbackPaused;
  elements.stopPlaybackButton.disabled = pendingReplayAction === "stop" ||
    (!playbackActive && !recaptureActive && !serverTransitioning);
  elements.rewindPlaybackButton.disabled = controlsBusy || finalisationRunning || recaptureActive ||
    (!playbackActive && playback.state === "idle");
  elements.backPlaybackButton.disabled = elements.rewindPlaybackButton.disabled;
  elements.forwardPlaybackButton.disabled = elements.rewindPlaybackButton.disabled;
  renderReplayProgress(
    status,
    playback,
    recaptureActive,
    replayFinished,
    playbackPreparing,
    playbackSeeking,
  );
  if (finalisationRunning) {
    elements.replayCaptureInfo.textContent =
      `Recapture complete; finalising ${currentVoyage?.recomputedReplay?.parentVoyage || "the new voyage"}.`;
  } else if (playbackPreparing) {
    elements.replayCaptureInfo.textContent =
      playbackSeeking
        ? `Seeking within ${selectedBundle?.fileName || playback.fileName || "the selected voyage"}.`
        : `Preparing ${selectedBundle?.fileName || playback.fileName || "the selected voyage"} for playback.`;
  } else if (playbackActive) {
    elements.replayCaptureInfo.textContent =
      `${playbackPaused ? "Paused" : "Playing"} ${playback.fileName || "the selected voyage"} using ${playback.mode === "recorded-output" ? "saved results" : "fresh calculations"}${recaptureActive ? " and saving a new recaptured voyage" : " without recording"}.`;
  } else if (playback.state === "complete") {
    elements.replayCaptureInfo.textContent =
      `Finished playing ${playback.fileName || "the voyage"}${playback.recapture ? "; the recaptured voyage is being finalised" : "; no new voyage was created"}.`;
  } else if (recaptureActive) {
    elements.replayCaptureInfo.textContent =
      `Recapturing ${currentVoyage.recomputedReplay.parentVoyage || "the parent voyage"} with current algorithms.`;
  } else if (selectedRecordedResult && selectedReady) {
    elements.replayCaptureInfo.textContent =
      `${selectedBundle.fileName}: ${selectedBundle.contentsLabel || "Inputs + saved results"} · ${selectedBundle.integrityLabel || "Complete"}. Choose saved results or fresh calculation.`;
  } else if (selectedRecordedResult) {
    elements.replayCaptureInfo.textContent =
      `${selectedBundle.fileName}: saved results only. Saved-result playback is available, but it cannot be recaptured without inputs.`;
  } else if (selectedReady) {
    elements.replayCaptureInfo.textContent =
      `${selectedBundle.fileName}: Inputs only · ${selectedBundle.integrityLabel || "Complete"}. Current algorithms will calculate fresh outputs.`;
  } else if (selectedBundle) {
    elements.replayCaptureInfo.textContent =
      `${selectedBundle.fileName} has no playable current voyage stream.`;
  } else {
    elements.replayCaptureInfo.textContent =
      "Select a voyage bundle below.";
  }
}

function renderReplayProgress(
  status,
  playback,
  recomputedActive,
  replayFinished,
  playbackPreparing,
  playbackSeeking,
) {
  const finalisation = status.finalisation || null;
  const standalonePlayback = playback.mode === "recorded-output";
  if (finalisation?.state === "running") {
    const zip = finalisation.zip || null;
    if (replayFinished || finalisation.streamsClosed === true) {
      elements.replayPlaybackState.textContent = finalisation.streamsClosed === true
        ? "Complete · Capture streams closed"
        : "Complete · finalising recomputed result";
    }
    elements.replayFinaliseValue.textContent = zip
      ? `Building ZIP · ${Number(zip.percent || 0).toFixed(1)}% · ${zip.entriesProcessed || 0}/${zip.entriesTotal || 0} files · ${formatBytes(zip.outputBytes || 0)} written`
      : `${titleCase(finalisation.phase || "finalising")} · ${finalisation.message || "Preparing ZIP"}`;
    renderTaskProgress(elements.replayFinaliseProgressBar, {
      active: true,
      percent: zip && Number.isFinite(Number(zip.percent))
        ? Number(zip.percent)
        : null,
      state: "running",
    });
  } else if (finalisation?.state === "complete") {
    elements.replayFinaliseValue.textContent =
      `Complete${finalisation.bundle?.fileName ? ` · ${finalisation.bundle.fileName}` : ""}`;
    renderTaskProgress(elements.replayFinaliseProgressBar, {
      active: true,
      percent: 100,
      state: "complete",
    });
  } else if (finalisation?.state === "failed") {
    elements.replayFinaliseValue.textContent =
      `FAILED · ${finalisation.error || "Voyage ZIP finalisation failed"}`;
    renderTaskProgress(elements.replayFinaliseProgressBar, {
      active: true,
      percent: null,
      state: "failed",
    });
  } else {
    renderTaskProgress(elements.replayFinaliseProgressBar, {
      active: false,
      percent: 0,
      state: "idle",
    });
  }
  const replayedRecords = finiteNumber(playback.recordsReplayed, 0);
  const totalRecords = finiteNumber(playback.recordsTotal, 0);
  const percent = totalRecords > 0
    ? Math.min(100, Math.max(0, replayedRecords / totalRecords * 100))
    : null;

  if (!(finalisation?.state === "running" && (replayFinished || finalisation.streamsClosed === true))) {
    elements.replayPlaybackState.textContent =
      playbackPreparing
        ? playbackSeeking ? "Seeking…" : "Preparing…"
        : playback.state === "failed"
        ? `FAILED · ${playback.error || "timing failure"}`
        : playback.state === "aborted"
          ? "Interrupted"
          : playback.active
            ? `Playing at fixed 1x · effective ${Number(playback.effectiveRatio || 0).toFixed(3)}x`
            : replayFinished
              ? standalonePlayback
                ? "Complete · recorded result EOF"
                : "Complete · canonical input EOF"
              : titleCase(playback.state || "idle");
  }
  elements.replayProgressValue.textContent = playbackPreparing
    ? playbackSeeking
      ? "Locating the requested voyage time…"
      : "Extracting and validating the voyage stream…"
    : totalRecords > 0
      ? `${replayedRecords} of ${totalRecords} ${standalonePlayback ? "recorded result" : "input"} records · ${percent.toFixed(1)}%`
      : "-";
  renderTaskProgress(elements.replayProgressBar, {
    active: playbackPreparing || playback.state !== "idle" || replayedRecords > 0,
    percent,
    state: playback.state === "failed"
      ? "failed"
      : playbackPreparing
        ? "running"
        : replayFinished
          ? "complete"
          : playback.active
            ? "running"
            : "idle",
  });
  elements.replaySegmentsValue.textContent = playback.sourceDurationMs > 0
    ? `Single monotonic ${standalonePlayback ? "recorded-result" : "input"} stream · ${formatDuration(playback.sourceDurationMs)} source · maximum lag ${Math.round(playback.maximumObservedLagMs || 0)} ms`
    : "Single monotonic stream";
  if (!finalisation || !["running", "complete", "failed"].includes(finalisation.state)) {
    elements.replayFinaliseValue.textContent =
      standalonePlayback
        ? "Not applicable · playback is not being recorded."
      : !recomputedActive
          ? "Not recording · enable recapture to save fresh results."
          : playback.state === "failed"
            ? `FAILED: ${playback.error || "Replay timing invalid"}. Interrupt to preserve partial evidence.`
            : playback.active
              ? "Available after canonical input EOF."
              : replayFinished
                ? "Ready: EOF and valid effective timing confirmed."
                : "Waiting for replay.";
  }
}

function renderTaskProgress(element, { active, percent, state }) {
  element.hidden = !active;
  element.dataset.state = state || "idle";
  if (!active) {
    element.value = 0;
    return;
  }
  if (Number.isFinite(percent)) {
    element.value = Math.min(100, Math.max(0, percent));
  } else {
    element.removeAttribute("value");
  }
}

function finiteNumber(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function titleCase(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function renderVoyageBundles(voyages) {
  // Playback status retains the loaded filename after Stop. Use it to restore
  // the row if a concurrent status refresh briefly omitted the selected ZIP.
  const selectedFileName = selectedBundle?.fileName || latestStatus?.playback?.fileName;
  selectedBundle = selectedFileName
    ? voyages.find((voyage) => voyage.fileName === selectedFileName) || null
    : null;
  updateSelectedBundleActions();
  if (!voyages.length) {
    elements.voyageBundles.innerHTML = '<p class="empty">No voyage bundles yet.</p>';
    return;
  }
  elements.voyageBundles.innerHTML = voyages
    .map((voyage) => `
      <button class="bundle-row ${selectedBundle && selectedBundle.fileName === voyage.fileName ? "active" : ""}" type="button" data-bundle="${escapeHtml(voyage.fileName)}">
        <div class="bundle-details">
          <strong>${escapeHtml(voyage.fileName)}</strong>
          <span>${escapeHtml(formatTime(voyage.modifiedAt))} · ${escapeHtml(formatBytes(voyage.bytes))}</span>
          <p class="bundle-comment"><span>Contents:</span> ${escapeHtml(voyage.contentsLabel || "Unknown")} · ${escapeHtml(voyage.integrityLabel || "Unknown")}${voyage.resultOrigin ? ` · ${escapeHtml(titleCase(voyage.resultOrigin))} results` : ""}</p>
          ${voyage.comment ? `<p class="bundle-comment"><span>Comment:</span> ${escapeHtml(voyage.comment)}</p>` : ""}
          ${voyage.recomputedReplay ? `<p class="bundle-comment"><span>Recomputed replay:</span> parent ${escapeHtml(voyage.recomputedReplay.parentVoyage || "unknown")}${voyage.recomputedReplay.incomplete === true ? " · INCOMPLETE / UNVERIFIED" : ""}</p>` : ""}
        </div>
      </button>
    `)
    .join("");
  elements.voyageBundles.querySelectorAll("[data-bundle]").forEach((button) => {
    button.addEventListener("click", () => {
      const voyage = voyages.find((item) => item.fileName === button.dataset.bundle);
      selectedBundle = voyage || null;
      elements.recaptureToggle.checked = false;
      elements.useSavedResultsToggle.checked = selectedBundle?.hasSavedResults === true;
      renderVoyageBundles(voyages);
      if (latestStatus) renderReplayRecorder(latestStatus);
    });
  });
}

function updateSelectedBundleActions() {
  const hasSelection = Boolean(selectedBundle);
  elements.deleteSelectedBundle.disabled = !hasSelection;
  elements.downloadSelectedBundle.classList.toggle("disabled", !hasSelection);
  elements.downloadSelectedBundle.setAttribute("aria-disabled", String(!hasSelection));
  if (hasSelection) {
    elements.selectedBundleInfo.textContent = selectedBundle.comment
      ? `${selectedBundle.fileName} · ${formatBytes(selectedBundle.bytes)} · Comment: ${selectedBundle.comment}`
      : `${selectedBundle.fileName} · ${formatBytes(selectedBundle.bytes)}`;
    elements.downloadSelectedBundle.href = selectedBundle.downloadUrl;
    elements.downloadSelectedBundle.download = selectedBundle.fileName;
  } else {
    elements.selectedBundleInfo.textContent = "Select a voyage bundle below.";
    elements.downloadSelectedBundle.href = "#";
    elements.downloadSelectedBundle.removeAttribute("download");
  }
}

async function deleteVoyage(fileName) {
  if (!window.confirm(`Delete voyage bundle ${fileName}? Make sure you have downloaded it first.`)) return;
  await command(`/voyages/${encodeURIComponent(fileName)}/delete`, {});
}

function formatBytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  if (number > 1024 * 1024 * 1024) return `${(number / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (number > 1024 * 1024) return `${(number / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(number / 1024)} KB`;
}

function formatDuration(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "-";
  const totalSeconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
