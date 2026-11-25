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

const SUFFIXES = ["ing", "es", "ed", "s"];

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
  video: document.getElementById("camera-video"),
  scanBox: document.getElementById("scan-box"),
  cameraFallback: document.getElementById("camera-fallback"),
  cameraErrorMsg: document.getElementById("camera-error-msg"),
  retryCameraBtn: document.getElementById("retry-camera-btn"),
  scanBtn: document.getElementById("scan-btn"),
  scanSpinner: document.getElementById("scan-spinner"),
  scanBtnText: document.getElementById("scan-btn-text"),
  resultCard: document.getElementById("result-card"),
  resultWord: document.getElementById("result-word"),
  resultIcon: document.getElementById("result-icon"),
  resultLabel: document.getElementById("result-label"),
  manualForm: document.getElementById("manual-form"),
  manualInput: document.getElementById("manual-input"),
  manualBtn: document.getElementById("manual-btn"),
  canvas: document.getElementById("capture-canvas"),
};

let wordSet = null;
let ocrWorker = null;
let ocrWorkerPromise = null;
let cameraReady = false;
let isScanning = false;

function setBanner(message, type = "info") {
  if (!message) {
    els.banner.classList.add("hidden");
    return;
  }
  els.banner.classList.remove("hidden", "banner--info", "banner--warn");
  els.banner.classList.add(type === "warn" ? "banner--warn" : "banner--info");
  els.statusText.textContent = message;
}

function updateScanButtonState() {
  els.scanBtn.disabled = isScanning || !cameraReady || !wordSet;
}

function setScanning(active) {
  isScanning = active;
  els.scanSpinner.classList.toggle("hidden", !active);
  els.scanBtnText.textContent = active ? "Reading..." : "Scan word";
  updateScanButtonState();
}

async function loadDictionary() {
  setBanner("Loading English dictionary…", "info");
  try {
    const response = await fetch("./words_alpha.txt");
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
    setBanner(null);
    updateScanButtonState();
  } catch (err) {
    console.error("Failed to load dictionary:", err);
    setBanner(
      "Could not load words_alpha.txt. Make sure you're running via a local server.",
      "warn"
    );
  }
}

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    cameraReady = false;
    els.cameraErrorMsg.textContent =
      "Camera API is unavailable in this browser or requires HTTPS/localhost. You can type a word below.";
    els.cameraFallback.classList.remove("hidden");
    updateScanButtonState();
    return;
  }

  els.cameraFallback.classList.add("hidden");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    els.video.srcObject = stream;
    await els.video.play();
    cameraReady = true;
    updateScanButtonState();
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
    updateScanButtonState();
  }
}

async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      if (typeof Tesseract === "undefined") {
        throw new Error("Tesseract.js failed to load from CDN.");
      }
      const worker = await Tesseract.createWorker("eng");
      ocrWorker = worker;
      return worker;
    })();
  }
  return ocrWorkerPromise;
}

/**
 * Capture the video region corresponding to the centered scan-box overlay,
 * accounting for object-fit: cover scaling, then convert to high-contrast grayscale.
 */
function captureScanRegion() {
  const video = els.video;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const videoRect = video.getBoundingClientRect();
  const boxRect = els.scanBox.getBoundingClientRect();

  // Compute object-fit: cover scale and centered offset
  const scale = Math.max(videoRect.width / vw, videoRect.height / vh);
  const offsetX = (videoRect.width - vw * scale) / 2;
  const offsetY = (videoRect.height - vh * scale) / 2;

  const relLeft = boxRect.left - videoRect.left;
  const relTop = boxRect.top - videoRect.top;

  const sx = Math.max(0, Math.floor((relLeft - offsetX) / scale));
  const sy = Math.max(0, Math.floor((relTop - offsetY) / scale));
  const sw = Math.min(vw - sx, Math.ceil(boxRect.width / scale));
  const sh = Math.min(vh - sy, Math.ceil(boxRect.height / scale));

  if (sw <= 0 || sh <= 0) return null;

  const canvas = els.canvas;
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);

  // Convert to grayscale and boost contrast
  const imageData = ctx.getImageData(0, 0, sw, sh);
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
 * Clean OCR text: lowercase, extract alphabetic tokens, filter ignored words,
 * and return the longest remaining token.
 */
function extractTargetWord(rawText) {
  if (!rawText) return "";
  const tokens = rawText.toLowerCase().match(/[a-z]+/g) || [];
  let best = "";
  for (const token of tokens) {
    if (IGNORE_WORDS.has(token)) continue;
    if (token.length > best.length) {
      best = token;
    }
  }
  return best;
}

/**
 * Check exact match or simple inflected variants by removing trailing s, es, ed, ing.
 */
function isRealEnglishWord(word, dictionary) {
  if (!word || !dictionary) return false;
  if (dictionary.has(word)) return true;

  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (stem.length >= 2 && dictionary.has(stem)) {
        return true;
      }
    }
  }
  return false;
}

function showResult(word, isReal) {
  const card = els.resultCard;
  card.classList.remove("hidden", "result-card--yes", "result-card--no", "is-animated");

  // Force reflow so animation replays on consecutive checks
  void card.offsetWidth;

  card.classList.add(isReal ? "result-card--yes" : "result-card--no", "is-animated");
  els.resultWord.textContent = word;
  els.resultIcon.innerHTML = isReal ? CHECK_ICON_SVG : X_ICON_SVG;
  els.resultLabel.textContent = isReal ? "YES, real word" : "NO, not a word";
}

function checkAndDisplayWord(rawInput, { filterIgnored = true } = {}) {
  if (!wordSet) {
    setBanner("Dictionary is still loading, please wait a moment…", "info");
    return;
  }

  let cleaned = "";
  if (filterIgnored) {
    cleaned = extractTargetWord(rawInput);
  } else {
    const tokens = (rawInput || "").toLowerCase().match(/[a-z]+/g) || [];
    cleaned = tokens.reduce((a, b) => (b.length > a.length ? b : a), "");
  }

  if (!cleaned) {
    setBanner("No word detected. Try centering the word in the frame or type it below.", "warn");
    return;
  }

  setBanner(null);
  const isReal = isRealEnglishWord(cleaned, wordSet);
  showResult(cleaned, isReal);
}

async function handleScan() {
  if (isScanning || !cameraReady || !wordSet) return;
  const canvas = captureScanRegion();
  if (!canvas) {
    setBanner("Camera frame is not ready yet. Please try again.", "warn");
    return;
  }

  setScanning(true);
  setBanner(null);
  try {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(canvas);
    checkAndDisplayWord(data.text, { filterIgnored: true });
  } catch (err) {
    console.error("OCR failed:", err);
    setBanner("OCR failed to read the frame. Please try again or type the word below.", "warn");
  } finally {
    setScanning(false);
  }
}

els.scanBtn.addEventListener("click", handleScan);
els.retryCameraBtn.addEventListener("click", startCamera);

els.manualForm.addEventListener("submit", (event) => {
  event.preventDefault();
  checkAndDisplayWord(els.manualInput.value, { filterIgnored: false });
});

loadDictionary();
startCamera();
