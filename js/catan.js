/**
 * Mega Catan companion: sun/moon turn display with a countdown.
 *
 * Games come from js/games.js (window.CatanGames.get(n) -> rounds -> turns).
 */

const WARN_SECONDS = 10;        // ticking + red clock from here (clock.mp3 is ~10s)
const ADVANCE_DELAY_MS = 2000;  // let the gong ring before the next turn
const UI_IDLE_MS = 3000;

const DEFAULTS = {
    shortSeconds: 30,
    longSeconds: 45,
    announceSeconds: 12,
    longFromRound: 2,   // 1-based
    longFromTurn: 17,   // 1-based
    autoAdvance: true,
    ticking: true,
    muted: false,
    volume: 0.8,
};

const STORE_SETTINGS = "catan.settings.v2";
const STORE_POSITION = "catan.position.v2";

const $ = (sel) => document.querySelector(sel);
const body = document.body;

/* ---------------- storage ---------------- */

function loadJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; }
}
function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
}

const settings = { ...DEFAULTS, ...loadJSON(STORE_SETTINGS) };
const saveSettings = () => saveJSON(STORE_SETTINGS, settings);

/* ---------------- sound ---------------- */

const sounds = Object.fromEntries(
    ["clock", "gong", "robber", "knight"].map((name) => {
        const a = new Audio(`sound/${name}.mp3`);
        a.preload = "auto";
        return [name, a];
    })
);

function playSound(name, from = 0) {
    if (settings.muted) return;
    const a = sounds[name];
    a.volume = settings.volume;
    try { a.currentTime = from; } catch { /* not loaded yet */ }
    a.play().catch(() => { /* autoplay blocked until first click */ });
}
function stopSound(name) {
    const a = sounds[name];
    a.pause();
    try { a.currentTime = 0; } catch { /* ignore */ }
}
function stopAllSounds() {
    Object.keys(sounds).forEach(stopSound);
}

/** Keep the ticking clip aligned with the countdown; handles pause, ±10s and mute. */
function syncTicking(left) {
    const clip = sounds.clock;
    const want = settings.ticking && !settings.muted && phase === "running" && left > 0 && left <= WARN_SECONDS;
    if (!want) {
        if (!clip.paused) clip.pause();
        return;
    }
    const target = WARN_SECONDS - left;
    clip.volume = settings.volume;
    if (clip.paused) {
        try { clip.currentTime = target; } catch { /* ignore */ }
        clip.play().catch(() => {});
    } else if (Math.abs(clip.currentTime - target) > 0.6) {
        clip.currentTime = target;
    }
}

/* ---------------- timer ---------------- */

const timer = {
    duration: 30,
    remaining: 30,
    endsAt: 0,
    running: false,

    reset(seconds) {
        this.duration = seconds;
        this.remaining = seconds;
        this.running = false;
    },
    start() {
        if (this.running) return;
        this.endsAt = performance.now() + this.remaining * 1000;
        this.running = true;
    },
    pause() {
        if (!this.running) return;
        this.remaining = this.left();
        this.running = false;
    },
    left() {
        return this.running ? Math.max(0, (this.endsAt - performance.now()) / 1000) : this.remaining;
    },
    add(seconds) {
        const next = Math.max(0, this.left() + seconds);
        this.duration = Math.max(this.duration, next);
        if (this.running) this.endsAt = performance.now() + next * 1000;
        else this.remaining = next;
    },
};

/* ---------------- game state ---------------- */

let games = null;      // window.CatanGames once booted
let pos = { game: 1, round: 0, turn: 0 };       // 0-based round/turn
let phase = "loading";  // loading | idle | running | paused | expired | done | error
let advanceTimeout = null;

const rounds = (g = pos.game) => (games && games.get(g)) || [];
const turnsIn = (g, r) => rounds(g)[r] || [];
const currentTurn = () => turnsIn(pos.game, pos.round)[pos.turn];

function isValid(p) {
    return !!(p && rounds(p.game)[p.round] && rounds(p.game)[p.round][p.turn]);
}

function kindOf(t) {
    if (t.event === "robber" || Number(t.id) === 0) {
        if (t.result === "active") return "announce";
        return Number(t.result) === 7 ? "desert" : "robber";
    }
    return "roll";
}

function durationFor(p, t) {
    if (kindOf(t) === "announce") return settings.announceSeconds;
    const long = p.round + 1 >= settings.longFromRound && p.turn + 1 >= settings.longFromTurn;
    return long ? settings.longSeconds : settings.shortSeconds;
}

function setPhase(next) {
    phase = next;
    body.dataset.phase = next;
    if (next !== "running") showUI();
}

function clearAdvance() {
    if (advanceTimeout) clearTimeout(advanceTimeout);
    advanceTimeout = null;
}

function persistPosition() {
    saveJSON(STORE_POSITION, pos);
    const url = new URL(location.href);
    url.searchParams.set("game", pos.game);
    url.searchParams.set("round", pos.round);
    url.searchParams.set("turn", pos.turn);
    try { history.replaceState(null, "", url); } catch { /* some browsers refuse on file:// */ }
}

/** Show a turn. `run` decides whether the countdown starts right away. */
function showTurn(p, { run = false, announce = true } = {}) {
    clearAdvance();
    stopAllSounds();
    pos = { ...p };
    persistPosition();

    const t = currentTurn();
    timer.reset(durationFor(pos, t));
    if (phase !== "idle") {
        setPhase(run ? "running" : "paused");
        if (run) timer.start();
    }
    render();
    if (announce && phase !== "idle") playEventSound(t);
}

function playEventSound(t) {
    const kind = kindOf(t);
    if (kind === "robber") playSound("robber");
    else if (kind === "desert") playSound("knight");
}

function neighbour(dir) {
    let { game, round, turn } = pos;
    turn += dir;
    if (turn >= turnsIn(game, round).length) { round += 1; turn = 0; }
    else if (turn < 0) {
        round -= 1;
        if (round < 0) return null;
        turn = turnsIn(game, round).length - 1;
    }
    const p = { game, round, turn };
    return isValid(p) ? p : null;
}

function step(dir, { run } = {}) {
    if (phase === "loading" || phase === "error") return;
    if (phase === "done") {
        if (dir < 0) { setPhase("paused"); showTurn(pos); }
        return;
    }
    const keepRunning = run ?? (phase === "running" || (phase === "expired" && advanceTimeout !== null));
    const p = neighbour(dir);
    if (!p) {
        if (dir > 0) {
            clearAdvance();
            stopAllSounds();
            timer.pause();
            setPhase("done");
            render();
        }
        return;
    }
    showTurn(p, { run: keepRunning });
}

function expire() {
    timer.pause();
    timer.remaining = 0;
    setPhase("expired");
    stopSound("clock");
    playSound("gong");
    if (settings.autoAdvance) {
        advanceTimeout = setTimeout(() => {
            advanceTimeout = null;
            step(1, { run: true });
        }, ADVANCE_DELAY_MS);
    }
    render();
}

/* ---------------- actions ---------------- */

function start() {
    if (phase !== "idle") return;
    setPhase("running");
    timer.start();
    playEventSound(currentTurn());
    render();
}

function toggle() {
    switch (phase) {
        case "idle": return start();
        case "running":
            timer.pause();
            setPhase("paused");
            break;
        case "paused":
            if (timer.left() <= 0) return step(1, { run: true });
            timer.start();
            setPhase("running");
            break;
        case "expired":
            if (advanceTimeout) {          // hold on the gong instead of moving on
                clearAdvance();
                setPhase("paused");
            } else {
                return step(1, { run: true });
            }
            break;
        default: return;
    }
    render();
}

function adjust(seconds) {
    if (!["running", "paused", "idle", "expired"].includes(phase)) return;
    if (phase === "expired") {
        if (seconds <= 0) return;
        clearAdvance();
        stopSound("gong");
        timer.add(seconds);
        timer.start();
        setPhase("running");
    } else {
        timer.add(seconds);
    }
    render();
}

function restartTurn() {
    if (phase === "loading" || phase === "error" || phase === "done") return;
    const wasRunning = phase === "running";
    showTurn(pos, { run: wasRunning, announce: false });
}

function toggleMute() {
    settings.muted = !settings.muted;
    saveSettings();
    if (settings.muted) stopAllSounds();
    render();
    syncSettingsForm();
}

function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
}

/* ---------------- rendering ---------------- */

const el = {
    hudGame: $("#hudGame"),
    hudRound: $("#hudRound"),
    hudTurn: $("#hudTurn"),
    hudTurns: $("#hudTurns"),
    hudStatus: $("#hudStatus"),
    clock: $("#clock"),
    ring: $("#ringBar"),
    sideLabel: $("#sideLabel"),
    eventTitle: $("#eventTitle"),
    dieSum: $("#dieSum"),
    dieParts: $("#dieParts"),
};

function render() {
    body.classList.toggle("muted", settings.muted);
    if (!games || !isValid(pos)) return;

    const t = currentTurn();
    const kind = kindOf(t);
    body.dataset.kind = kind;
    if (t.side) body.dataset.side = t.side;

    el.hudGame.textContent = pos.game;
    el.hudRound.textContent = pos.round + 1;
    el.hudTurn.textContent = pos.turn + 1;
    el.hudTurns.textContent = turnsIn(pos.game, pos.round).length;
    el.sideLabel.textContent = t.side === "MOON" ? "Måne" : "Sol";

    const sum = kind === "roll" ? Number(t[1]) + Number(t[2]) : Number(t.result);
    if (el.dieSum.textContent !== String(sum)) {
        el.dieSum.textContent = sum;
        const die = el.dieSum.parentElement;   // restart the pop animation
        die.style.animation = "none";
        void die.offsetWidth;
        die.style.animation = "";
    }
    el.dieParts.textContent = kind === "roll" ? `${t[1]} + ${t[2]}` : "";
    el.eventTitle.textContent = kind === "desert" ? "Tyven går til ørkenen" : kind === "robber" ? "Tyven slår til" : "";

    const status = {
        idle: "Klar",
        running: settings.autoAdvance ? "" : "Automatisk neste tur er av",
        paused: "Pause",
        expired: advanceTimeout ? "Tiden er ute" : "Tiden er ute – trykk ▶ for neste tur",
        done: "Ferdig",
    }[phase] ?? "";
    el.hudStatus.textContent = status;

    draw();
}

let lastClockText = "";
function draw() {
    const left = timer.left();
    const whole = Math.ceil(left - 1e-6);
    const text = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
    if (text !== lastClockText) {
        el.clock.textContent = text;
        lastClockText = text;
    }
    const frac = timer.duration > 0 ? left / timer.duration : 0;
    el.ring.style.strokeDashoffset = String(1000 * (1 - frac));
    body.classList.toggle("warn", left <= WARN_SECONDS && ["running", "paused", "expired"].includes(phase));
}

/* Logic runs on an interval (keeps working in background tabs); drawing on rAF for a smooth ring. */
function logicTick() {
    if (phase === "running") {
        const left = timer.left();
        if (left <= 0) return expire();
        syncTicking(left);
    } else {
        syncTicking(0);
    }
}
setInterval(logicTick, 100);

(function frame() {
    if (phase === "running") draw();
    requestAnimationFrame(frame);
})();

/* ---------------- UI: controls, keyboard, idle hide ---------------- */

let idleTimer = null;
function showUI() {
    body.classList.remove("ui-idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        if (phase === "running" && !dialog.open) body.classList.add("ui-idle");
    }, UI_IDLE_MS);
}
["mousemove", "pointerdown", "touchstart"].forEach((ev) => window.addEventListener(ev, showUI, { passive: true }));

const actions = {
    prev: () => step(-1),
    next: () => step(1),
    toggle,
    minus: () => adjust(-10),
    plus: () => adjust(10),
    restart: restartTurn,
    mute: toggleMute,
    fullscreen: toggleFullscreen,
    settings: openSettings,
};

document.querySelector(".controls").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    actions[btn.dataset.action]();
    btn.blur();   // so Space doesn't re-trigger the focused button
});

$("#startBtn").addEventListener("click", start);
$("#nextGameBtn").addEventListener("click", () => {
    const next = pos.game >= games.MAX_GAME ? 1 : pos.game + 1;
    setPhase("idle");
    showTurn({ game: next, round: 0, turn: 0 });
});
$("#doneSettingsBtn").addEventListener("click", openSettings);

window.addEventListener("keydown", (e) => {
    if (dialog.open || e.ctrlKey || e.altKey || e.metaKey) return;
    const map = {
        " ": "toggle", k: "toggle", Enter: "toggle",
        ArrowRight: "next", PageDown: "next", n: "next",
        ArrowLeft: "prev", PageUp: "prev", p: "prev",
        ArrowUp: "plus", "+": "plus",
        ArrowDown: "minus", "-": "minus",
        r: "restart", m: "mute", f: "fullscreen", s: "settings",
    };
    const action = map[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!action) return;
    if (action === "toggle" && phase === "done") return;
    e.preventDefault();
    showUI();
    actions[action]();
});

/* ---------------- settings dialog ---------------- */

const dialog = $("#settings");
const form = $("#settingsForm");
const jumpGame = $("#jumpGame");
const jumpRound = $("#jumpRound");
const jumpTurn = $("#jumpTurn");

function syncSettingsForm() {
    for (const [key, value] of Object.entries(settings)) {
        const input = form.elements[key];
        if (!input) continue;
        if (input.type === "checkbox") input.checked = !!value;
        else input.value = value;
    }
}

function syncJumpLimits() {
    const g = Number(jumpGame.value);
    jumpRound.max = rounds(g).length;
    const r = Math.min(Math.max(1, Number(jumpRound.value) || 1), rounds(g).length) - 1;
    jumpTurn.max = turnsIn(g, r).length;
}

function openSettings() {
    if (!games) return;
    if (phase === "running") toggle();   // pause while fiddling with settings
    syncSettingsForm();
    jumpGame.value = pos.game;
    jumpRound.value = pos.round + 1;
    jumpTurn.value = pos.turn + 1;
    syncJumpLimits();
    dialog.showModal();
}

form.addEventListener("input", (e) => {
    const input = e.target;
    if (!(input.name in DEFAULTS)) {
        if (input === jumpGame || input === jumpRound) syncJumpLimits();
        return;
    }
    if (input.type === "checkbox") settings[input.name] = input.checked;
    else if (input.type === "range") settings[input.name] = Number(input.value);
    else {
        const n = Math.round(Number(input.value));
        if (!Number.isFinite(n) || n < Number(input.min || 1)) return;
        settings[input.name] = n;
    }
    saveSettings();
    if (input.name === "muted" && settings.muted) stopAllSounds();
    if (input.name === "autoAdvance" && !settings.autoAdvance) clearAdvance();
    render();
});

function jumpTo(p) {
    if (!isValid(p)) {
        alert("Den turen finnes ikke i valgt spill.");
        return;
    }
    dialog.close();
    if (phase === "done" || phase === "expired") setPhase("paused");
    showTurn(p);
}

$("#jumpBtn").addEventListener("click", () => jumpTo({
    game: Number(jumpGame.value),
    round: Number(jumpRound.value) - 1,
    turn: Number(jumpTurn.value) - 1,
}));
$("#newGameBtn").addEventListener("click", () => {
    dialog.close();
    setPhase("idle");
    showTurn({ game: Number(jumpGame.value), round: 0, turn: 0 });
});
dialog.addEventListener("close", showUI);

/* ---------------- boot ---------------- */

function initialPosition() {
    const q = new URLSearchParams(location.search);
    if (q.has("game")) {
        const p = { game: Number(q.get("game")), round: Number(q.get("round")) || 0, turn: Number(q.get("turn")) || 0 };
        if (isValid(p)) return p;
    }
    const saved = loadJSON(STORE_POSITION);
    if (saved && isValid(saved)) return saved;
    return { game: 1, round: 0, turn: 0 };
}

function boot() {
    games = window.CatanGames;
    if (!games) {
        $("#errorText").textContent = "Fant ikke js/games.js.";
        setPhase("error");
        return;
    }

    jumpGame.max = games.MAX_GAME;
    syncSettingsForm();
    setPhase("idle");
    showTurn(initialPosition());
}

boot();
