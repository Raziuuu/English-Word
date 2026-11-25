const IGNORE_WORDS = new Set([
  "is",
  "this",
  "a",
  "real",
  "english",
  "word",
  "yes",
  "no",
]);

const DICTIONARY_API_URL = "https://api.dictionaryapi.dev/api/v2/entries/en/";
const API_TIMEOUT_MS = 3000;
const AUTO_SCAN_INTERVAL_MS = 300;
const MAX_OCR_WIDTH = 800;
const MIN_WORD_CONFIDENCE = 60;

const CHECK_ICON_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>
`;

const X_ICON_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"></line>
    <line x1="6" y1="6" x2="18" y2="18"></line>
  </svg>
`;

const els = {
  banner: document.getElementById("status-banner"),
  statusText: document.getElementById("status-text"),
  viewport: document.getElementById("camera-viewport"),
  video: document.getElementById("camera-video"),
  scanBox: document.getElementById("scan-box"),
  cameraFallback: document.getElementById("camera-fallback"),
  cameraErrorMsg: document.getElementById("camera-error-msg"),
  retryCameraBtn: document.getElementById("retry-camera-btn"),
  zoomOutBtn: document.getElementById("zoom-out-btn"),
  zoomSlider: document.getElementById("zoom-slider"),
  zoomInBtn: document.getElementById("zoom-in-btn"),
  zoomValue: document.getElementById("zoom-value"),
  zoomMode: document.getElementById("zoom-mode"),
  resultCard: document.getElementById("result-card"),
  resultWord: document.getElementById("result-word"),
  resultIcon: document.getElementById("result-icon"),
  resultLabel: document.getElementById("result-label"),
  resultSource: document.getElementById("result-source"),
  manualForm: document.getElementById("manual-form"),
  manualInput: document.getElementById("manual-input"),
  manualBtn: document.getElementById("manual-btn"),
  canvas: document.getElementById("capture-canvas"),
};

let wordSet = null;
let dictionaryError = false;
let ocrWorker = null;
let ocrError = false;
let cameraReady = false;
let isCheckingManual = false;
const apiCache = new Map();

// Continuous auto-scan state
let scanTimerId = null;
let ocrInFlight = false;
let lastShownWord = "";
let lastShownIsReal = null;
let lastShownSource = "";

// Zoom state
let videoTrack = null;
let zoomMode = "digital"; // "optical" | "digital"
let zoomMin = 1;
let zoomMax = 5;
let zoomStep = 0.1;
let targetZoom = 1;
let currentZoom = 1;
let lastAppliedHardwareZoom = null;
let hardwareZoomBusy = false;
let hardwareZoomQueued = false;
let zoomRafId = null;

// Pointer pinch & double-tap state
const activePointers = new Map();
let initialPinchDistance = 0;
let initialPinchZoom = 1;
let hadPinchGesture = false;
let lastTapTime = 0;
let lastTapX = 0;
let lastTapY = 0;

function blockPageZoom() {
  for (const evt of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(evt, (e) => e.preventDefault(), {
      passive: false,
      capture: true,
    });
  }

  const preventMultiTouch = (e) => {
    if (e.touches && e.touches.length > 1) {
      e.preventDefault();
    }
  };
  document.addEventListener("touchstart", preventMultiTouch, {
    passive: false,
    capture: true,
  });
  document.addEventListener("touchmove", preventMultiTouch, {
    passive: false,
    capture: true,
  });

  document.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
      }
    },
    { passive: false, capture: true }
  );
}

function setBanner(message, type = "info") {
  if (!message) {
    els.banner.classList.add("hidden");
    return;
  }
  els.banner.classList.remove("hidden", "banner--info", "banner--warn");
  els.banner.classList.add(type === "warn" ? "banner--warn" : "banner--info");
  els.statusText.textContent = message;
}

function updateStartupBanner() {
  if (dictionaryError) {
    setBanner(
      "Could not load words.txt. Make sure you're running via a local server.",
      "warn"
    );
    return;
  }
  if (ocrError) {
    setBanner(
      "Could not initialize OCR engine. You can still type a word below.",
      "warn"
    );
    return;
  }
  if (!wordSet && !ocrWorker) {
    setBanner("Loading dictionary and OCR engine…", "info");
    return;
  }
  if (!wordSet) {
    setBanner("Loading English dictionary…", "info");
    return;
  }
  if (!ocrWorker) {
    setBanner("Preparing OCR engine…", "info");
    return;
  }
  setBanner(null);
}

function clampZoom(value) {
  return Math.min(zoomMax, Math.max(zoomMin, value));
}

function snapToStep(value) {
  const clamped = clampZoom(value);
  if (!zoomStep || zoomStep <= 0) return clamped;
  const steps = Math.round((clamped - zoomMin) / zoomStep);
  return clampZoom(zoomMin + steps * zoomStep);
}

function updateZoomUI(value) {
  els.zoomSlider.value = String(value);
  els.zoomValue.textContent = `${value.toFixed(1)}x`;
  els.zoomOutBtn.disabled = !cameraReady || value <= zoomMin + 0.001;
  els.zoomInBtn.disabled = !cameraReady || value >= zoomMax - 0.001;
  els.zoomSlider.disabled = !cameraReady;
}

async function flushHardwareZoom() {
  if (!videoTrack || zoomMode !== "optical") return;
  if (hardwareZoomBusy) {
    hardwareZoomQueued = true;
    return;
  }

  const desired = snapToStep(currentZoom);
  if (
    lastAppliedHardwareZoom !== null &&
    Math.abs(desired - lastAppliedHardwareZoom) < 0.001
  ) {
    return;
  }

  hardwareZoomBusy = true;
  try {
    await videoTrack.applyConstraints({ advanced: [{ zoom: desired }] });
    lastAppliedHardwareZoom = desired;
  } catch (err) {
    console.warn("Hardware zoom constraint failed, falling back to digital zoom:", err);
    zoomMode = "digital";
    zoomMin = 1;
    zoomMax = 5;
    zoomStep = 0.1;
    els.zoomSlider.min = "1";
    els.zoomSlider.max = "5";
    els.zoomSlider.step = "0.1";
    els.zoomMode.textContent = "Digital zoom";
    targetZoom = clampZoom(targetZoom);
    currentZoom = clampZoom(currentZoom);
    els.video.style.transform = `scale(${currentZoom.toFixed(4)})`;
    updateZoomUI(currentZoom);
  } finally {
    hardwareZoomBusy = false;
    if (hardwareZoomQueued) {
      hardwareZoomQueued = false;
      flushHardwareZoom();
    }
  }
}

function applyZoomFrame() {
  zoomRafId = null;
  const diff = targetZoom - currentZoom;
  if (Math.abs(diff) < 0.004) {
    currentZoom = targetZoom;
  } else {
    currentZoom += diff * 0.35;
    zoomRafId = requestAnimationFrame(applyZoomFrame);
  }

  if (zoomMode === "optical") {
    els.video.style.transform = "";
    flushHardwareZoom();
  } else {
    els.video.style.transform = `scale(${currentZoom.toFixed(4)})`;
  }

  updateZoomUI(currentZoom);
}

function setZoom(value, { immediate = false } = {}) {
  if (!cameraReady) return;
  targetZoom = clampZoom(value);
  if (immediate) {
    if (zoomRafId !== null) {
      cancelAnimationFrame(zoomRafId);
      zoomRafId = null;
    }
    currentZoom = targetZoom;
    if (zoomMode === "optical") {
      els.video.style.transform = "";
      flushHardwareZoom();
    } else {
      els.video.style.transform = `scale(${currentZoom.toFixed(4)})`;
    }
    updateZoomUI(currentZoom);
    return;
  }

  if (zoomRafId === null) {
    zoomRafId = requestAnimationFrame(applyZoomFrame);
  }
}

function resetZoom() {
  setZoom(clampZoom(1));
}

function configureZoomCapabilities(track) {
  videoTrack = track;
  lastAppliedHardwareZoom = null;

  const capabilities =
    typeof track.getCapabilities === "function" ? track.getCapabilities() : {};
  const zCap = capabilities && capabilities.zoom;

  if (
    zCap &&
    typeof zCap.min === "number" &&
    typeof zCap.max === "number" &&
    zCap.max > zCap.min
  ) {
    zoomMode = "optical";
    zoomMin = zCap.min;
    zoomMax = zCap.max;
    zoomStep = typeof zCap.step === "number" && zCap.step > 0 ? zCap.step : 0.1;

    const settings =
      typeof track.getSettings === "function" ? track.getSettings() : {};
    const initial =
      typeof settings.zoom === "number" ? clampZoom(settings.zoom) : clampZoom(1);

    els.zoomMode.textContent = "Optical zoom";
    els.video.style.transform = "";
    els.zoomSlider.min = String(zoomMin);
    els.zoomSlider.max = String(zoomMax);
    els.zoomSlider.step = String(zoomStep);
    setZoom(initial, { immediate: true });
  } else {
    zoomMode = "digital";
    zoomMin = 1;
    zoomMax = 5;
    zoomStep = 0.1;
    els.zoomMode.textContent = "Digital zoom";
    els.zoomSlider.min = "1";
    els.zoomSlider.max = "5";
    els.zoomSlider.step = "0.1";
    setZoom(1, { immediate: true });
  }
}

async function loadDictionary() {
  updateStartupBanner();
  try {
    const response = await fetch("./words.txt");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    const words = text.split(/\r?\n/);
    const set = new Set();
    for (let i = 0; i < words.length; i += 1) {
      const w = words[i].trim().toLowerCase();
      if (w) set.add(w);
    }
    wordSet = set;
    updateStartupBanner();
    maybeStartAutoScan();
  } catch (err) {
    console.error("Failed to load dictionary:", err);
    dictionaryError = true;
    updateStartupBanner();
  }
}

async function initOcrWorker() {
  updateStartupBanner();
  try {
    if (typeof Tesseract === "undefined") {
      throw new Error("Tesseract.js failed to load from CDN.");
    }
    const worker = await Tesseract.createWorker("eng");
    await worker.setParameters({
      tessedit_char_whitelist:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz?",
    });
    ocrWorker = worker;
    updateStartupBanner();
    maybeStartAutoScan();
  } catch (err) {
    console.error("OCR worker initialization failed:", err);
    ocrError = true;
    updateStartupBanner();
  }
}

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    cameraReady = false;
    els.cameraErrorMsg.textContent =
      "Camera API is unavailable in this browser or requires HTTPS/localhost. You can type a word below.";
    els.cameraFallback.classList.remove("hidden");
    updateZoomUI(1);
    return;
  }

  els.cameraFallback.classList.add("hidden");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    els.video.srcObject = stream;
    await els.video.play();
    cameraReady = true;

    const [track] = stream.getVideoTracks();
    if (track) {
      configureZoomCapabilities(track);
    } else {
      updateZoomUI(1);
    }

    maybeStartAutoScan();
  } catch (err) {
    console.error("Camera error:", err);
    cameraReady = false;
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      els.cameraErrorMsg.textContent =
        "Camera permission was denied. Allow camera access in your browser settings, or type a word below.";
    } else if (err.name === "NotFoundError") {
      els.cameraErrorMsg.textContent =
        "No camera was found on this device. You can still type a word below to check it.";
    } else {
      els.cameraErrorMsg.textContent =
        "Could not start the camera. You can still type a word below to check it.";
    }
    els.cameraFallback.classList.remove("hidden");
    updateZoomUI(1);
  }
}

/**
 * Capture the video region matching the centered scan-box overlay and current zoom,
 * downscale to at most 800px wide for OCR speed, convert to grayscale, and boost contrast.
 */
function captureScanRegion() {
  const video = els.video;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const viewportRect = els.viewport.getBoundingClientRect();
  const boxRect = els.scanBox.getBoundingClientRect();
  if (!viewportRect.width || !viewportRect.height) return null;

  const coverScale = Math.max(viewportRect.width / vw, viewportRect.height / vh);
  const digitalZoom = zoomMode === "digital" ? currentZoom : 1;

  const visibleSourceW = viewportRect.width / (coverScale * digitalZoom);
  const visibleSourceH = viewportRect.height / (coverScale * digitalZoom);

  const relLeft = (boxRect.left - viewportRect.left) / viewportRect.width;
  const relTop = (boxRect.top - viewportRect.top) / viewportRect.height;
  const relW = boxRect.width / viewportRect.width;
  const relH = boxRect.height / viewportRect.height;

  const visibleOriginX = (vw - visibleSourceW) / 2;
  const visibleOriginY = (vh - visibleSourceH) / 2;

  const sx = Math.max(0, Math.floor(visibleOriginX + relLeft * visibleSourceW));
  const sy = Math.max(0, Math.floor(visibleOriginY + relTop * visibleSourceH));
  const sw = Math.min(vw - sx, Math.max(1, Math.ceil(relW * visibleSourceW)));
  const sh = Math.min(vh - sy, Math.max(1, Math.ceil(relH * visibleSourceH)));

  if (sw <= 0 || sh <= 0) return null;

  const outW = sw > MAX_OCR_WIDTH ? MAX_OCR_WIDTH : sw;
  const outH = Math.max(1, Math.round((sh * outW) / sw));

  const canvas = els.canvas;
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH);

  // Convert to grayscale and boost contrast
  const imageData = ctx.getImageData(0, 0, outW, outH);
  const data = imageData.data;
  const contrastFactor = 1.75;

  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const boosted = Math.max(0, Math.min(255, (gray - 128) * contrastFactor + 128));
    data[i] = boosted;
    data[i + 1] = boosted;
    data[i + 2] = boosted;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Pick the target word from Tesseract word-level results:
 * largest bounding box height, confidence > 60, letters only,
 * and not in IGNORE_WORDS.
 */
function pickTargetWordFromWords(words) {
  if (!Array.isArray(words) || words.length === 0) return "";
  let bestWord = "";
  let bestHeight = 0;

  for (const w of words) {
    if (!w || typeof w.confidence !== "number" || w.confidence <= MIN_WORD_CONFIDENCE) {
      continue;
    }
    const token = (w.text || "").trim().toLowerCase();
    if (!/^[a-z]+$/.test(token)) continue;
    if (IGNORE_WORDS.has(token)) continue;

    const bbox = w.bbox;
    const height =
      bbox && typeof bbox.y1 === "number" && typeof bbox.y0 === "number"
        ? bbox.y1 - bbox.y0
        : 0;

    if (height > bestHeight) {
      bestHeight = height;
      bestWord = token;
    }
  }

  return bestWord;
}

/**
 * Query the Free Dictionary API with a 3-second timeout and Map cache.
 * Returns true for HTTP 200 with a non-empty array, false otherwise.
 */
async function checkDictionaryApi(word) {
  if (apiCache.has(word)) {
    return apiCache.get(word);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${DICTIONARY_API_URL}${encodeURIComponent(word)}`,
      { signal: controller.signal }
    );

    if (response.status === 200) {
      const data = await response.json();
      const isReal = Array.isArray(data) && data.length > 0;
      apiCache.set(word, isReal);
      return isReal;
    }

    if (response.status === 404) {
      apiCache.set(word, false);
      return false;
    }

    return false;
  } catch (err) {
    console.warn("Dictionary API lookup failed:", err);
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Strict word check: curated Set first, then Free Dictionary API.
 * No suffix stripping or stemming guesses.
 */
async function verifyWord(word) {
  if (!word || !wordSet) {
    return { isReal: false, source: "not found" };
  }

  if (wordSet.has(word)) {
    return { isReal: true, source: "curated list" };
  }

  const apiFound = await checkDictionaryApi(word);
  if (apiFound) {
    return { isReal: true, source: "dictionary API" };
  }

  return { isReal: false, source: "not found" };
}

function showResult(word, isReal, source) {
  if (
    word === lastShownWord &&
    isReal === lastShownIsReal &&
    source === lastShownSource &&
    !els.resultCard.classList.contains("hidden")
  ) {
    return;
  }

  lastShownWord = word;
  lastShownIsReal = isReal;
  lastShownSource = source;

  const card = els.resultCard;
  card.classList.remove("hidden", "result-card--yes", "result-card--no", "is-animated");

  // Force reflow so animation replays when the detected word changes
  void card.offsetWidth;

  card.classList.add(isReal ? "result-card--yes" : "result-card--no", "is-animated");
  els.resultWord.textContent = word;
  els.resultIcon.innerHTML = isReal ? CHECK_ICON_SVG : X_ICON_SVG;
  els.resultLabel.textContent = isReal ? "YES, real word" : "NO, not a word";
  els.resultSource.textContent = source;
}

function canAutoScan() {
  return (
    cameraReady &&
    wordSet !== null &&
    ocrWorker !== null &&
    document.visibilityState === "visible"
  );
}

function stopAutoScanTimer() {
  if (scanTimerId !== null) {
    clearTimeout(scanTimerId);
    scanTimerId = null;
  }
}

function scheduleNextScan(delayMs = AUTO_SCAN_INTERVAL_MS) {
  stopAutoScanTimer();
  if (!canAutoScan() || ocrInFlight) return;
  scanTimerId = setTimeout(runAutoScanTick, delayMs);
}

function maybeStartAutoScan() {
  if (canAutoScan() && !ocrInFlight && scanTimerId === null) {
    scheduleNextScan(0);
  }
}

async function runAutoScanTick() {
  scanTimerId = null;
  if (!canAutoScan() || ocrInFlight) return;

  const canvas = captureScanRegion();
  if (!canvas) {
    scheduleNextScan(AUTO_SCAN_INTERVAL_MS);
    return;
  }

  ocrInFlight = true;
  try {
    const { data } = await ocrWorker.recognize(canvas);
    if (document.visibilityState === "visible") {
      const detected = pickTargetWordFromWords(data && data.words);
      if (detected) {
        const { isReal, source } = await verifyWord(detected);
        if (document.visibilityState === "visible") {
          showResult(detected, isReal, source);
        }
      }
    }
  } catch (err) {
    console.warn("Auto-scan OCR error:", err);
  } finally {
    ocrInFlight = false;
    if (canAutoScan()) {
      scheduleNextScan(AUTO_SCAN_INTERVAL_MS);
    }
  }
}

async function checkManualWord(rawInput) {
  if (!wordSet) {
    setBanner("Dictionary is still loading, please wait a moment…", "info");
    return;
  }

  const tokens = (rawInput || "").toLowerCase().match(/[a-z]+/g) || [];
  const cleaned = tokens.reduce((a, b) => (b.length > a.length ? b : a), "");

  if (!cleaned) {
    setBanner("Enter letters to check a word.", "warn");
    return;
  }

  updateStartupBanner();
  const { isReal, source } = await verifyWord(cleaned);
  showResult(cleaned, isReal, source);
}

function getPinchDistance() {
  const pts = Array.from(activePointers.values());
  if (pts.length < 2) return 0;
  return Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
}

function setupZoomInteractions() {
  const buttonStep = () => Math.max(zoomStep, (zoomMax - zoomMin) / 16);

  els.zoomSlider.addEventListener("input", () => {
    setZoom(parseFloat(els.zoomSlider.value));
  });

  els.zoomOutBtn.addEventListener("click", () => {
    setZoom(targetZoom - buttonStep());
  });

  els.zoomInBtn.addEventListener("click", () => {
    setZoom(targetZoom + buttonStep());
  });

  els.viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (!cameraReady) return;
      const span = zoomMax - zoomMin;
      const delta = -e.deltaY * 0.0018 * span;
      setZoom(targetZoom + delta);
    },
    { passive: false }
  );

  els.viewport.addEventListener(
    "touchmove",
    (e) => {
      if (cameraReady) {
        e.preventDefault();
      }
    },
    { passive: false }
  );

  els.viewport.addEventListener("dblclick", () => {
    if (!cameraReady) return;
    resetZoom();
  });

  els.viewport.addEventListener("pointerdown", (e) => {
    if (!cameraReady) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size === 1) {
      hadPinchGesture = false;
    } else if (activePointers.size === 2) {
      hadPinchGesture = true;
      initialPinchDistance = getPinchDistance();
      initialPinchZoom = targetZoom;
    }
  });

  window.addEventListener("pointermove", (e) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size === 2 && initialPinchDistance > 0) {
      const dist = getPinchDistance();
      if (dist > 0) {
        setZoom(initialPinchZoom * (dist / initialPinchDistance));
      }
    }
  });

  const handlePointerEnd = (e) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) {
      initialPinchDistance = 0;
    }

    if (e.pointerType === "touch" && activePointers.size === 0 && !hadPinchGesture) {
      const now = Date.now();
      const dist = Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY);
      if (now - lastTapTime < 300 && dist < 24) {
        resetZoom();
        lastTapTime = 0;
      } else {
        lastTapTime = now;
        lastTapX = e.clientX;
        lastTapY = e.clientY;
      }
    }
  };

  window.addEventListener("pointerup", handlePointerEnd);
  window.addEventListener("pointercancel", handlePointerEnd);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    stopAutoScanTimer();
  } else {
    maybeStartAutoScan();
  }
});

els.retryCameraBtn.addEventListener("click", startCamera);

els.manualForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isCheckingManual) return;
  isCheckingManual = true;
  els.manualBtn.disabled = true;
  try {
    await checkManualWord(els.manualInput.value);
  } finally {
    isCheckingManual = false;
    els.manualBtn.disabled = false;
  }
});

blockPageZoom();
setupZoomInteractions();
loadDictionary();
initOcrWorker();
startCamera();
