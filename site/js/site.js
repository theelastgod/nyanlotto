const clockEl = document.querySelector("#clock");
const ring = document.querySelector("#ring");
const phaseEl = document.querySelector("#phase");
const prizeEl = document.querySelector("#prize");
const unitEl = document.querySelector("#prize-unit");
const feeEl = document.querySelector("#fee");
const onHandEl = document.querySelector("#onhand");
const treasuryEl = document.querySelector("#treasury");
const statusEl = document.querySelector("#status-line");
const buyerEl = document.querySelector("#buyer");
const youEl = document.querySelector("#you");
const historyEl = document.querySelector("#history");
const nyanMintEl = document.querySelector("#nyan-mint");
const audio = document.querySelector("#theme");
const timeEl = document.querySelector("#time");

let state = null;
let wallet = null;
const WINDOW = 60_000;

function short(value) {
  if (!value) return "";
  return value.length < 12 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function paintClock() {
  const now = Date.now();
  let left = WINDOW;
  let label = "ready";
  const phase = state?.phase;
  if (phase === "countdown" && state.deadline) {
    left = Math.max(0, state.deadline - now);
    label = "left";
  } else if (phase === "paying") {
    left = 0;
    label = "paying";
  }
  const seconds = left / 1000;
  clockEl.textContent = seconds.toFixed(1);
  document.querySelector("#clock-label").textContent = label === "left" ? "seconds" : label;
  ring.style.setProperty("--p", String(Math.max(0, Math.min(1, left / WINDOW))));
}

function paint() {
  if (!state) return;
  const labels = {
    unarmed: "Waiting for the mint and treasury",
    setup: "Finish setup to arm payouts",
    waiting: "Waiting for the first buy",
    countdown: "A buy resets this clock",
    paying: "Paying the last buyer in $PLTR",
  };
  phaseEl.textContent = labels[state.phase] || state.phase;
  if (state.pltrQuote && state.pltrQuote !== "0") {
    prizeEl.textContent = state.pltrQuote;
    unitEl.textContent = "$PLTR stock";
  } else {
    prizeEl.textContent = state.feePotSol ?? "0.0";
    unitEl.textContent = "paid as $PLTR stock";
  }
  feeEl.textContent = state.feePotSol == null ? "—" : `${state.feePotSol} SOL`;
  onHandEl.textContent = state.pltrOnHand || "0";
  treasuryEl.textContent = state.treasury ? short(state.treasury) : "Not set";
  buyerEl.textContent = state.lastBuyer ? short(state.lastBuyer) : "Nobody yet";
  nyanMintEl.textContent = state.mint || "Mint not launched";
  const armed = state.payoutsArmed
    ? "Payouts are armed. The reserve of 0.05 SOL does not leave the treasury."
    : "Payouts arm when the $NYAN mint and the treasury key are set. Until then the clock is only a preview.";
  statusEl.textContent = state.lastError ? `${armed} ${state.lastError}` : armed;
  paintYou();
  paintHistory();
}

function paintYou() {
  if (!wallet) {
    youEl.textContent = "";
    return;
  }
  const mine = state?.lastBuyer === wallet;
  youEl.textContent = mine ? "You are the last buyer." : `${short(wallet)} is connected.`;
}

function paintHistory() {
  const rounds = state?.rounds || [];
  if (!rounds.length) {
    historyEl.innerHTML = '<li class="empty">No rounds yet.</li>';
    return;
  }
  historyEl.innerHTML = rounds.map((round) => {
    const prize = round.empty ? "Pot was empty" : `${round.pltrText || "0"} $PLTR`;
    return `<li><span>${short(round.buyer)}</span><span>${prize}</span></li>`;
  }).join("");
}

async function pull() {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (!res.ok) return;
    state = await res.json();
    paint();
  } catch {
    phaseEl.textContent = "Clock preview";
  }
}

document.querySelector("#connect").addEventListener("click", async () => {
  const provider = window.solana || window.phantom?.solana;
  if (!provider) {
    youEl.textContent = "Open this page in a wallet browser, or install Phantom.";
    return;
  }
  const reply = await provider.connect();
  wallet = reply.publicKey.toString();
  paintYou();
});

function formatTime(seconds) {
  const whole = Math.floor(seconds || 0);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

const playButtons = [document.querySelector("#play"), document.querySelector("#playTop")];
function syncPlay() {
  const label = audio.paused ? "Play" : "Pause";
  playButtons[0].textContent = label;
  playButtons[1].textContent = audio.paused ? "Play the song" : "Pause the song";
  playButtons[1].classList.toggle("playing", !audio.paused);
}
async function toggle() {
  if (audio.paused) await audio.play();
  else audio.pause();
  syncPlay();
}
playButtons.forEach((button) => button.addEventListener("click", toggle));
audio.volume = 0.8;
function startSong() {
  return audio.play().then(syncPlay);
}
startSong().catch(() => {
  const unlock = () => {
    startSong().finally(() => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    });
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
});
audio.addEventListener("timeupdate", () => {
  timeEl.textContent = formatTime(audio.currentTime);
});
document.querySelector("#volume").addEventListener("input", (event) => {
  audio.volume = Number(event.target.value);
});

const stars = document.querySelector("#stars");
const ctx = stars.getContext("2d");
const dots = Array.from({ length: 80 }, () => ({
  x: Math.random(),
  y: Math.random(),
  r: Math.random() * 1.6 + 0.4,
  s: Math.random() * 0.0004 + 0.0001,
}));
function frame() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (stars.width !== w || stars.height !== h) {
    stars.width = w;
    stars.height = h;
  }
  ctx.clearRect(0, 0, stars.width, stars.height);
  ctx.fillStyle = "#ffffff";
  for (const dot of dots) {
    dot.x = (dot.x + dot.s) % 1;
    ctx.globalAlpha = 0.4 + dot.r / 3;
    ctx.beginPath();
    ctx.arc(dot.x * stars.width, dot.y * stars.height, dot.r, 0, Math.PI * 2);
    ctx.fill();
  }
  requestAnimationFrame(frame);
}
frame();

async function flyers() {
  const img = new Image();
  img.src = "/media/nyan-pixel.jpg";
  try { await img.decode(); } catch { return; }
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const g = canvas.getContext("2d");
  g.drawImage(img, 0, 0);
  const frameData = g.getImageData(0, 0, canvas.width, canvas.height);
  const px = frameData.data;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i];
    const b = px[i + 2];
    const navy = b > 30 && b >= r && b >= px[i + 1] && Math.max(r, px[i + 1], b) < 170 && (b - r) > 8;
    if (navy) px[i + 3] = 0;
  }
  g.putImageData(frameData, 0, 0);
  const url = canvas.toDataURL("image/png");
  const layer = document.querySelector("#flyers");
  for (let i = 0; i < 4; i += 1) {
    const flyer = document.createElement("img");
    flyer.className = "flyer";
    flyer.src = url;
    flyer.alt = "";
    flyer.style.top = `${12 + i * 18}%`;
    flyer.style.animationDuration = `${11 + i * 3}s`;
    flyer.style.animationDelay = `${-i * 3}s`;
    layer.appendChild(flyer);
  }
}

paintClock();
setInterval(paintClock, 100);
pull();
setInterval(pull, 2000);
flyers();
