// ============ CONFIG ============
const CLIENT_ID = "a700407476634a24b29cae4e11d3604e";
// Doit être EXACTEMENT la même que la Redirect URI déclarée dans le Dashboard Spotify
const REDIRECT_URI = location.origin + location.pathname;
const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
].join(" ");
const POLL_MS = 3000;
// ================================

const API = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const $ = (id) => document.getElementById(id);

const els = {
  login: $("login-view"), player: $("player-view"), status: $("status"),
  cover: $("cover"), coverWrap: document.querySelector(".cover-wrap"), backdrop: $("backdrop"),
  title: $("title"), artist: $("artist"), album: $("album"), device: $("device"),
  barFill: $("bar-fill"), bar: document.querySelector(".bar"),
  timeNow: $("time-now"), timeTotal: $("time-total"),
  play: $("play-btn"), iconPlay: $("icon-play"), iconPause: $("icon-pause"),
  prev: $("prev-btn"), next: $("next-btn"), shuffle: $("shuffle-btn"),
  loginBtn: $("login-btn"), logoutBtn: $("logout-btn"),
};

// ---------- Auth (Authorization Code + PKCE) ----------
const store = {
  get: (k) => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
  del: (k) => localStorage.removeItem(k),
};

function randomString(len = 64) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

async function challengeFrom(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function login() {
  if (CLIENT_ID.startsWith("COLLE")) {
    return setStatus("Renseigne ton Client ID dans app.js.");
  }
  const verifier = randomString(64);
  store.set("sp_verifier", verifier);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: await challengeFrom(verifier),
  });
  location.href = "https://accounts.spotify.com/authorize?" + params;
}

function saveTokens(data) {
  store.set("sp_access", data.access_token);
  store.set("sp_expires", String(Date.now() + data.expires_in * 1000));
  if (data.refresh_token) store.set("sp_refresh", data.refresh_token);
}

async function requestToken(body) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
  });
  if (!res.ok) throw new Error("token");
  saveTokens(await res.json());
}

async function handleCallback() {
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (!code && !error) return;
  history.replaceState({}, "", REDIRECT_URI); // nettoie l'URL
  if (error) return setStatus("Connexion refusée.");
  try {
    await requestToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: store.get("sp_verifier"),
    });
    store.del("sp_verifier");
  } catch {
    setStatus("Connexion impossible. Vérifie le Client ID et la Redirect URI.");
  }
}

async function getToken() {
  const access = store.get("sp_access");
  if (!access) return null;
  if (Date.now() < Number(store.get("sp_expires")) - 60000) return access;
  const refresh = store.get("sp_refresh");
  if (!refresh) return null;
  try {
    await requestToken({ grant_type: "refresh_token", refresh_token: refresh });
    return store.get("sp_access");
  } catch {
    return null;
  }
}

function logout() {
  ["sp_access", "sp_expires", "sp_refresh", "sp_verifier"].forEach(store.del);
  clearTimeout(pollTimer);
  showView(false);
  setStatus("");
}

// ---------- API ----------
async function api(path, method = "GET") {
  const token = await getToken();
  if (!token) { logout(); throw new Error("auth"); }
  const res = await fetch(API + path, { method, headers: { Authorization: "Bearer " + token } });
  if (res.status === 401) { logout(); throw new Error("auth"); }
  return res;
}

async function control(path, method = "POST") {
  try {
    const res = await api(path, method);
    if (res.status === 403) setStatus("Cette commande demande Spotify Premium.");
    else if (res.status === 404) setStatus("Aucun appareil actif. Ouvre Spotify sur ton téléphone ou ton PC.");
    else if (!res.ok) setStatus("Commande refusée par Spotify.");
    else setStatus("");
  } catch { /* déjà géré */ }
  setTimeout(poll, 400);
}

// ---------- Affichage ----------
let pollTimer;
let track = { progress: 0, duration: 0, playing: false, at: 0 };

function setStatus(msg) { els.status.textContent = msg; }

function showView(loggedIn) {
  els.login.hidden = loggedIn;
  els.player.hidden = !loggedIn;
}

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function render(state) {
  const item = state && state.item;
  if (!item) {
    track = { progress: 0, duration: 0, playing: false, at: Date.now() };
    els.title.textContent = "Rien en lecture";
    els.artist.textContent = "Lance un titre sur un appareil Spotify.";
    els.album.textContent = "";
    els.device.textContent = "";
    els.cover.removeAttribute("src");
    els.coverWrap.classList.remove("has-cover");
    els.backdrop.classList.remove("on");
    setPlayIcon(false);
    drawProgress();
    return;
  }

  const img = (item.album && item.album.images && item.album.images[0]) || null;
  els.title.textContent = item.name;
  els.artist.textContent = (item.artists || []).map((a) => a.name).join(", ");
  els.album.textContent = item.album ? item.album.name : "";
  els.device.textContent = state.device ? "Sur " + state.device.name : "";

  if (img && els.cover.getAttribute("src") !== img.url) {
    els.cover.src = img.url;
    els.backdrop.style.backgroundImage = `url("${img.url}")`;
  }
  els.coverWrap.classList.toggle("has-cover", !!img);
  els.backdrop.classList.toggle("on", !!img);

  els.shuffle.setAttribute("aria-pressed", String(!!state.shuffle_state));
  track = {
    progress: state.progress_ms || 0,
    duration: item.duration_ms || 0,
    playing: !!state.is_playing,
    at: Date.now(),
  };
  setPlayIcon(track.playing);
  drawProgress();
}

function setPlayIcon(playing) {
  els.iconPlay.hidden = playing;
  els.iconPause.hidden = !playing;
  els.play.setAttribute("aria-label", playing ? "Pause" : "Lecture");
}

function drawProgress() {
  const now = track.playing ? Math.min(track.duration, track.progress + (Date.now() - track.at)) : track.progress;
  const pct = track.duration ? (now / track.duration) * 100 : 0;
  els.barFill.style.width = pct + "%";
  els.bar.setAttribute("aria-valuenow", String(Math.round(pct)));
  els.timeNow.textContent = fmt(now);
  els.timeTotal.textContent = fmt(track.duration);
}

// ---------- Boucle de mise à jour ----------
async function poll() {
  clearTimeout(pollTimer);
  try {
    const res = await api("/me/player");
    if (res.status === 204) render(null);          // aucun appareil actif
    else if (res.ok) { render(await res.json()); setStatus(""); }
    else setStatus("Erreur Spotify (" + res.status + ").");
  } catch { return; }
  pollTimer = setTimeout(poll, document.hidden ? POLL_MS * 3 : POLL_MS);
}

// ---------- Événements ----------
els.loginBtn.addEventListener("click", login);
els.logoutBtn.addEventListener("click", logout);
els.play.addEventListener("click", () => {
  const wasPlaying = track.playing;
  track.progress = wasPlaying ? track.progress + (Date.now() - track.at) : track.progress;
  track.playing = !wasPlaying; track.at = Date.now();
  setPlayIcon(track.playing);
  control(wasPlaying ? "/me/player/pause" : "/me/player/play", "PUT");
});
els.next.addEventListener("click", () => control("/me/player/next"));
els.prev.addEventListener("click", () => control("/me/player/previous"));
els.shuffle.addEventListener("click", () => {
  const on = els.shuffle.getAttribute("aria-pressed") !== "true";
  els.shuffle.setAttribute("aria-pressed", String(on));
  control("/me/player/shuffle?state=" + on, "PUT");
});
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && e.target === document.body) { e.preventDefault(); els.play.click(); }
});

setInterval(() => { if (track.playing) drawProgress(); }, 250);

// ---------- Démarrage ----------
(async function init() {
  await handleCallback();
  if (await getToken()) { showView(true); poll(); }
  else showView(false);
})();
