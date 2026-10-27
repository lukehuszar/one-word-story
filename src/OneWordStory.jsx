import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import { useRegisterSW } from "virtual:pwa-register/react";
import { pushSupported, pushAllowedHere, PUSH_ORIGIN, isIOSDevice, isInstalledApp, isPushEnabled, enablePush, disablePush, syncPushSubscription, sendTestPush } from "./push.js";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (in .env locally, or in Vercel's Environment Variables)
// to point the app at a different Supabase project. The fallbacks are this project's public values:
// the anon ("publishable") key is designed to be public; what protects the data is Row Level Security.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://wzeenraywlbxhecdnrfv.supabase.co";
const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_7LjFzl3p3NkkEoCv7AL1qQ_eA1zhltb";

// Read the URL hash before Supabase consumes it, so we know the user arrived via a reset link
const RECOVERY_IN_URL =
  typeof window !== "undefined" && window.location.hash.includes("type=recovery");

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// A tapped notification opens "/?game=<id>" (a query string, because the URL hash is used for password-reset links)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEEP_LINK_GAME = (() => {
  try { const g = new URLSearchParams(window.location.search).get("game"); return g && UUID_RE.test(g) ? g : null; }
  catch { return null; }
})();

// ─── HELPERS ─────────────────────────────────────────────────────────────────
// Punctuation allowed around a word (hyphens/apostrophes inside a word are handled separately)
const PUNCT = `.,!?;:"'“”‘’()…—–`;
const P = PUNCT.replace(/[\]\\^-]/g, "\\$&");

// [tail + space]? [0-2 punct] word [0-2 punct]
//   tail   = 1–2 punctuation marks that attach to the PREVIOUS word (e.g. ". " or '." ')
//   prefix = 0–2 marks before the word (e.g. “ or ("), suffix = 0–2 marks after (e.g. !")
const ENTRY_RE = new RegExp(
  `^(?:([${P}]{1,2})\\s+)?([${P}]{0,2})([\\p{L}\\p{N}_][\\p{L}\\p{N}_'’-]*)([${P}]{0,2})$`,
  "u"
);

// Phone keyboards auto-curl quotes, which look wrong in the story font, so everything is stored and shown straight
function straighten(str) {
  return str.replace(/[“”„‟]/g, '"').replace(/[‘’‚‛]/g, "'");
}

function parseEntry(input) {
  const trimmed = straighten(input).trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > 50) return null;
  const m = ENTRY_RE.exec(trimmed);
  if (!m) return null;
  return { normalized: trimmed, tail: m[1] || "", prefix: m[2], body: m[3], suffix: m[4] };
}

// For display: split a stored entry into the part that glues to the previous word and the rest.
// Lenient on purpose so older entries (no tail) always render fine.
function splitEntry(rawText) {
  const text = straighten(rawText); // also fixes older entries saved with curly quotes
  const m = /^([^\s\p{L}\p{N}]{1,3})\s+(.+)$/u.exec(text);
  return m ? { tail: m[1], body: m[2] } : { tail: "", body: text };
}

// A player's own row in a game (null if they were never in it)
function getMyRow(game, userId) {
  return game?.game_players?.find((p) => p.user_id === userId) || null;
}

function timeLeft(deadline) {
  if (!deadline) return null;
  const diff = new Date(deadline) - new Date();
  if (diff <= 0) return "Expired";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 24) return `${Math.floor(h / 24)}d left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m ${Math.floor((diff % 60000) / 1000)}s left`;
}

// Turn length in seconds (every game row has turn_time_limit_seconds; the legacy hours column is kept in sync by the database)
function turnSeconds(g) {
  return g?.turn_time_limit_seconds || 86400;
}

const TURN_PRESETS = [3600, 21600, 43200, 86400, 172800]; // 1, 6, 12, 24, 48 hours
const MIN_TURN_SECONDS = 10;
const MAX_TURN_SECONDS = 7 * 24 * 3600;

function validTurnSeconds(n) {
  return Number.isInteger(n) && n >= MIN_TURN_SECONDS && n <= MAX_TURN_SECONDS;
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0 && !m && !s) return h === 1 ? "1 hour" : `${h} hours`;
  return [h && `${h} hr`, m && `${m} min`, s && `${s} sec`].filter(Boolean).join(" ");
}

function storyText(words) {
  return words
    .map((w, i) => {
      const { tail, body } = splitEntry(w.word_text);
      if (i === 0) return body;
      const sep = w.break_before === "para" ? "\n\n" : w.break_before === "line" ? "\n" : " ";
      return `${tail}${sep}${body}`;
    })
    .join("")
    .trimStart();
}

// ─── SOUND ───────────────────────────────────────────────────────────────────
// Preference is stored per device. Enabled unless explicitly switched off.
const SOUND_KEY = "ows_sound_enabled";

function getSoundEnabled() {
  try { return localStorage.getItem(SOUND_KEY) !== "false"; } catch { return true; }
}

function saveSoundEnabled(on) {
  try { localStorage.setItem(SOUND_KEY, String(on)); } catch { /* storage unavailable */ }
}

// ─── MY-WORDS HIGHLIGHT ──────────────────────────────────────────────────────
// Stored per device. Colour plus a style (text colour, underline, or marker) so it doesn't rely on hue alone.
const HIGHLIGHT_KEY = "ows_highlight";
const DEFAULT_HIGHLIGHT = { color: "#8c2a08", style: "color" };
const HIGHLIGHT_COLORS = [
  { name: "Rust", value: "#8c2a08" },
  { name: "Navy", value: "#1d3f9b" },
  { name: "Purple", value: "#5b2a86" },
  { name: "Forest", value: "#1f5f2e" },
  { name: "Plain ink", value: "#3a2813" },
];
const HIGHLIGHT_STYLES = [
  { id: "color", label: "Text color" },
  { id: "underline", label: "Underline" },
  { id: "marker", label: "Highlighter" },
];

function getHighlight() {
  try {
    const v = JSON.parse(localStorage.getItem(HIGHLIGHT_KEY));
    if (v && /^#[0-9a-f]{6}$/i.test(v.color) && HIGHLIGHT_STYLES.some((s) => s.id === v.style)) return v;
  } catch { /* storage unavailable or malformed */ }
  return DEFAULT_HIGHLIGHT;
}

function saveHighlight(h) {
  try { localStorage.setItem(HIGHLIGHT_KEY, JSON.stringify(h)); } catch { /* storage unavailable */ }
}

function applyHighlight(h) {
  const root = document.documentElement;
  root.style.setProperty("--mine-color", h.color);
  root.dataset.mineStyle = h.style;
}

if (typeof window !== "undefined") applyHighlight(getHighlight());

let audioCtx = null;

function getAudioCtx() {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) audioCtx = new AC();
  return audioCtx;
}

// Browsers only allow audio after a user gesture, so unlock on the first tap/keypress
function unlockAudio() {
  const ctx = getAudioCtx();
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
}

if (typeof window !== "undefined") {
  ["pointerdown", "keydown", "touchend"].forEach((ev) =>
    window.addEventListener(ev, unlockAudio, { passive: true })
  );
}

// Synthesised bell: a few inharmonic sine partials with a long decay (no audio file needed)
function playBell() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.35, now + 0.01);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 1.8);
  master.connect(ctx.destination);

  const base = 880;
  [[1, 1], [2.76, 0.5], [5.4, 0.25], [8.93, 0.12]].forEach(([ratio, amp]) => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = base * ratio;
    g.gain.setValueAtTime(amp, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.8 / Math.sqrt(ratio));
    osc.connect(g);
    g.connect(master);
    osc.start(now);
    osc.stop(now + 1.9);
  });
}

// ─── AVATAR HELPERS ──────────────────────────────────────────────────────────
// Center-crop to a square and shrink to 256px JPEG so uploads stay tiny
function resizeImageToBlob(file, size = 256) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      canvas.getContext("2d").drawImage(img, sx, sy, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Could not process that image."))),
        "image/jpeg",
        0.85
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file doesn't look like an image we can read."));
    };
    img.src = url;
  });
}

// ─── GAME LOGIC ──────────────────────────────────────────────────────────────
// The rules (whose turn it is, skipping expired turns, saving words) live in the database as
// functions; the app only asks. Each call either succeeds or throws with a readable message.
async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

// Skip the current player if their deadline has passed. Safe to call from every open phone.
function advanceIfExpired(gameId) {
  return rpc("advance_game_if_expired", { p_game: gameId });
}

async function submitWord(game, word, fmt = {}) {
  // Same check the server runs, so mistakes get instant feedback without a round trip
  if (!parseEntry(word))
    throw new Error(
      'Use one word, with up to 2 punctuation marks before and 2 after (e.g. "Heavens!"). To end the previous sentence, start with punctuation and a space (e.g. ". Then,").'
    );
  await rpc("submit_word", {
    p_game: game.id,
    p_text: word,
    p_bold: !!fmt.bold,
    p_italic: !!fmt.italic,
    p_break: fmt.break_before || "none",
  });
}

// ─── STYLES ──────────────────────────────────────────────────────────────────
const css = `
  /* fonts are self-hosted (imported in main.jsx), so the installed app works offline */

  * { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --ink: #1a1612;
    --ink2: #4a4540;
    --ink3: #8a847e;
    --paper: #faf8f4;
    --paper2: #f2ede5;
    --paper3: #e8e1d6;
    --accent: #c2480f;
    --accent2: #e8753a;
    --green: #2d6a4f;
    --border: rgba(26,22,18,0.12);
    --radius: 12px;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --ink: #f0ebe3;
      --ink2: #b8b0a5;
      --ink3: #7a7268;
      --paper: #1a1714;
      --paper2: #221f1b;
      --paper3: #2e2a25;
      --border: rgba(240,235,227,0.1);
    }
  }

  body {
    font-family: 'Lora', Georgia, serif;
    background: var(--paper);
    color: var(--ink);
    min-height: 100vh;
    min-height: 100dvh; /* iOS: 100vh jumps when the address bar moves */
    -webkit-font-smoothing: antialiased;
  }

  .app {
    max-width: 480px;
    margin: 0 auto;
    min-height: 100vh;
    min-height: 100dvh;
    padding: 0 0 env(safe-area-inset-bottom, 0);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: calc(20px + env(safe-area-inset-top, 0px)) 20px 12px; /* clear the status bar in the installed app */
    border-bottom: 1px solid var(--border);
  }

  .header-title {
    font-family: 'Lora', serif;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.3px;
  }

  .logo-mark {
    font-family: 'DM Mono', monospace;
    font-size: 11px;
    color: var(--accent);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    opacity: 0.8;
  }

  .screen { padding: 24px 20px; }

  /* ── Auth ── */
  .auth-hero {
    text-align: center;
    padding: 40px 0 32px;
  }

  .auth-wordmark {
    font-size: 32px;
    font-weight: 600;
    letter-spacing: -1px;
    line-height: 1.1;
    margin-bottom: 8px;
  }

  .auth-sub {
    font-size: 14px;
    color: var(--ink3);
    font-style: italic;
  }

  .auth-divider {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 20px 0;
    color: var(--ink3);
    font-size: 12px;
    font-family: 'DM Mono', monospace;
  }

  .auth-divider::before,
  .auth-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  /* ── Forms ── */
  .field { margin-bottom: 16px; }

  .field label {
    display: block;
    font-size: 11px;
    font-family: 'DM Mono', monospace;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink3);
    margin-bottom: 6px;
  }

  .field input,
  .field select {
    width: 100%;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--paper2);
    color: var(--ink);
    font-family: 'Lora', serif;
    font-size: 15px;
    outline: none;
    transition: border-color 0.15s;
    -webkit-appearance: none;
  }

  .field input:focus,
  .field select:focus {
    border-color: var(--accent);
  }

  .btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    padding: 14px 20px;
    border-radius: var(--radius);
    font-size: 15px;
    font-family: 'Lora', serif;
    font-weight: 600;
    cursor: pointer;
    border: none;
    transition: opacity 0.15s, transform 0.1s;
  }

  .btn:active { transform: scale(0.98); }
  .btn:disabled { opacity: 0.45; cursor: not-allowed; transform: none; }

  .btn-primary {
    background: var(--accent);
    color: #fff;
  }

  .btn-ghost {
    background: var(--paper2);
    color: var(--ink2);
    border: 1px solid var(--border);
  }

  .btn-sm {
    padding: 9px 16px;
    font-size: 13px;
    width: auto;
  }

  /* ── Game list ── */
  .section-label {
    font-family: 'DM Mono', monospace;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--ink3);
    margin: 24px 0 10px;
  }

  .game-card {
    background: var(--paper2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
    margin-bottom: 10px;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }

  .game-card:hover { border-color: var(--accent); }

  .game-card.your-turn {
    border-color: var(--accent);
    background: var(--paper);
  }

  .game-card-title {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 4px;
  }

  .game-card-meta {
    font-size: 12px;
    font-family: 'DM Mono', monospace;
    color: var(--ink3);
  }

  .your-turn-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--accent);
    color: #fff;
    font-size: 10px;
    font-family: 'DM Mono', monospace;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 3px 8px;
    border-radius: 99px;
    margin-bottom: 6px;
  }

  /* ── Story display ── */
  .story-box {
    background: var(--paper2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    min-height: 120px;
    margin-bottom: 20px;
    line-height: 1.8;
    font-size: 17px;
    font-style: normal; /* italic is now per-word, so the box itself is upright */
    color: var(--ink);
    position: relative;
  }

  .story-empty {
    font-size: 14px;
    font-style: italic;
    color: var(--ink3);
  }

  .word-chip {
    display: inline;
  }

  .word-chip.mine {
    color: var(--accent2);
  }

  /* ── Turn status ── */
  .turn-status {
    border-radius: var(--radius);
    padding: 14px 16px;
    margin-bottom: 16px;
    font-size: 14px;
  }

  .turn-status.my-turn {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    color: var(--accent);
  }

  .turn-status.waiting {
    background: var(--paper2);
    border: 1px solid var(--border);
    color: var(--ink2);
  }

  .turn-status-name {
    font-weight: 600;
    font-size: 15px;
    margin-bottom: 2px;
  }

  .turn-status-time {
    font-size: 12px;
    font-family: 'DM Mono', monospace;
    opacity: 0.7;
  }

  /* ── Word input ── */
  .word-input-row {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
  }

  .word-input-row .field {
    flex: 1;
    margin-bottom: 0;
  }

  .word-input-row input {
    font-size: 18px;
    font-weight: 600;
    font-style: italic;
  }

  .word-input-row .btn {
    width: auto;
    min-width: 90px;
  }

  /* ── Player list ── */
  .player-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    background: var(--paper2);
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 8px;
    font-size: 14px;
  }

  .player-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--paper3);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-family: 'DM Mono', monospace;
    color: var(--ink2);
    flex-shrink: 0;
  }

  .player-name { font-weight: 600; flex: 1; }

  .player-avatar { overflow: hidden; }
  .player-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }

  .avatar-btn {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    border-radius: 50%;
    display: flex;
  }
  .avatar-btn:hover .player-avatar,
  .avatar-btn:focus-visible .player-avatar { border-color: var(--accent); }

  /* ── Profile ── */
  .profile-hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 8px 0 24px;
  }
  .profile-name { font-size: 20px; font-weight: 600; }
  .profile-actions { display: flex; gap: 8px; }

  .setting-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 14px 16px;
    background: var(--paper2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
    margin-bottom: 10px;
  }
  .setting-row input {
    width: 20px;
    height: 20px;
    margin-top: 2px;
    flex-shrink: 0;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .setting-title { font-size: 15px; font-weight: 600; }
  .setting-hint { font-size: 12px; color: var(--ink3); margin-top: 2px; }

  /* ── Username suggestions ── */
  .suggest-wrap { position: relative; }
  .suggest-list {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    z-index: 50;
    list-style: none;
    background: var(--paper);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 6px 20px rgba(0,0,0,0.12);
    overflow: hidden;
  }
  .suggest-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    cursor: pointer;
    font-size: 14px;
  }
  .suggest-item + .suggest-item { border-top: 1px solid var(--border); }
  .suggest-item.active,
  .suggest-item:hover { background: var(--paper2); }
  .suggest-match { color: var(--accent); font-weight: 600; }

  .remove-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--ink3);
    font-size: 18px;
    padding: 0 4px;
    line-height: 1;
  }

  .remove-btn:hover { color: var(--accent); }

  /* ── Error / toast ── */
  .error-box {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 13px;
    color: var(--accent);
    margin-bottom: 14px;
  }

  .toast {
    position: fixed;
    bottom: calc(24px + env(safe-area-inset-bottom, 0px));
    left: 50%;
    transform: translateX(-50%);
    background: var(--ink);
    color: var(--paper);
    padding: 10px 20px;
    border-radius: 99px;
    font-size: 13px;
    font-family: 'DM Mono', monospace;
    z-index: 999;
    animation: toastIn 0.2s ease;
  }

  @keyframes toastIn {
    from { opacity: 0; transform: translate(-50%, 8px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }

  .spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .back-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--ink2);
    font-size: 15px;
    font-family: 'Lora', serif;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0;
  }

  .back-btn:hover { color: var(--accent); }

  .completed-banner {
    background: color-mix(in srgb, var(--green) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--green) 30%, transparent);
    color: var(--green);
    border-radius: var(--radius);
    padding: 12px 16px;
    margin-bottom: 16px;
    font-size: 14px;
    font-style: italic;
  }

  .username-hint {
    font-size: 12px;
    color: var(--ink3);
    margin-top: 4px;
    font-family: 'DM Mono', monospace;
  }

  .fab {
    position: fixed;
    bottom: calc(24px + env(safe-area-inset-bottom, 0px));
    right: 20px;
    width: 52px;
    height: 52px;
    border-radius: 50%;
    background: var(--accent);
    color: #fff;
    border: none;
    font-size: 24px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 16px rgba(194,72,15,0.4);
    transition: transform 0.1s;
    z-index: 100;
  }

  .fab:active { transform: scale(0.93); }

  .end-game-row {
    display: flex;
    justify-content: flex-end;
    margin-top: 8px;
  }

  .btn-danger {
    background: none;
    border: 1px solid var(--border);
    color: var(--ink3);
    font-size: 12px;
    font-family: 'DM Mono', monospace;
    padding: 7px 14px;
    border-radius: 8px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }

  .btn-danger:hover { color: var(--accent); border-color: var(--accent); }

  .refresh-row {
    display: flex;
    justify-content: center;
    margin: 8px 0 16px;
  }

  .refresh-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--ink3);
    font-size: 12px;
    font-family: 'DM Mono', monospace;
    padding: 7px 16px;
    border-radius: 99px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .refresh-btn:hover { border-color: var(--ink3); }

  .empty-state {
    text-align: center;
    padding: 48px 20px;
    color: var(--ink3);
    font-style: italic;
    font-size: 15px;
  }

  /* ── Parchment story window ── */
  .story-box {
    font-family: 'IM Fell English', 'Goudy Old Style', Garamond, Georgia, serif;
    font-size: 19px;
    line-height: 1.75;
    color: #3a2813;
    padding: 26px 24px;
    border: 1px solid rgba(96, 64, 28, 0.55);
    border-radius: 6px 11px 7px 12px / 11px 6px 12px 7px;
    background-color: #e8d4a6;
    background-image:
      url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n' x='0' y='0' width='100%25' height='100%25'><feTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.38 0 0 0 0 0.26 0 0 0 0 0.1 0 0 0 0.35 0'/></filter><rect width='240' height='240' filter='url(%23n)'/></svg>"),
      radial-gradient(ellipse at 18% 12%, rgba(255, 247, 220, 0.85), transparent 55%),
      radial-gradient(ellipse at 88% 92%, rgba(160, 105, 45, 0.35), transparent 60%),
      linear-gradient(160deg, #ecdab0, #e0c995);
    box-shadow:
      inset 0 0 38px rgba(120, 78, 28, 0.5),
      inset 0 0 6px rgba(90, 56, 20, 0.5),
      0 3px 12px rgba(0, 0, 0, 0.22);
    text-shadow: 0 0 1px rgba(58, 40, 19, 0.35);
    overflow-wrap: anywhere;
  }
  .story-box .word-chip.mine { color: var(--mine-color, #8c2a08); }
  :root[data-mine-style="underline"] .story-box .word-chip.mine {
    text-decoration: underline;
    text-decoration-color: var(--mine-color);
    text-decoration-thickness: 2px;
    text-underline-offset: 4px;
  }
  :root[data-mine-style="marker"] .story-box .word-chip.mine {
    color: #3a2813;
    background: color-mix(in srgb, var(--mine-color) 35%, transparent);
    border-radius: 3px;
  }
  .hl-dot {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 1px solid rgba(0, 0, 0, 0.35);
    margin-right: 6px;
    vertical-align: -1px;
  }
  .hl-custom {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    color: var(--ink2);
    margin-bottom: 12px;
  }
  .hl-custom input { width: 40px; height: 30px; padding: 0; border: none; background: none; cursor: pointer; }
  .story-box .story-empty { color: #7b6140; font-size: 17px; }

  /* ── Story screen: back + refresh row, undo, custom time ── */
  .play-nav-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 8px 0 16px;
  }
  .undo-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    margin-bottom: 12px;
    background: var(--paper2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 14px;
    color: var(--ink2);
  }
  .duration-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 10px;
  }
  .duration-row label { margin-bottom: 4px; }

  /* ── Word formatting ── */
  .w-bold { font-weight: 700; }
  .w-italic { font-style: italic; }
  .para-break { display: block; height: 0.75em; }

  .format-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 12px;
  }
  .fmt-btn {
    min-width: 44px;
    padding: 8px 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--paper2);
    color: var(--ink2);
    font-family: 'Lora', serif;
    font-size: 14px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .fmt-btn:hover:not(:disabled) { border-color: var(--accent); }
  .fmt-btn.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .fmt-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .inline-form { display: flex; gap: 8px; }
  .inline-form input {
    flex: 1;
    min-width: 0;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--paper2);
    color: var(--ink);
    font-family: 'Lora', serif;
    font-size: 15px;
    outline: none;
    -webkit-appearance: none;
  }
  .inline-form input:focus { border-color: var(--accent); }

  /* ── Word count, leave / archive ── */
  .story-meta {
    display: flex;
    justify-content: flex-end;
    margin: -12px 4px 16px;
    font-family: 'DM Mono', monospace;
    font-size: 12px;
    color: var(--ink3);
  }
  .action-row {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    margin: -4px 0 16px;
  }
  .action-row .reopen-btn { flex: 1 1 100%; }
  .end-game-row { gap: 8px; }
  .player-row.left { opacity: 0.55; }
  .left-tag {
    font-size: 11px;
    font-family: 'DM Mono', monospace;
    color: var(--ink3);
    background: var(--paper3);
    padding: 2px 8px;
    border-radius: 99px;
  }
  .game-card.left-game { opacity: 0.75; }
  .game-card-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .nav-row {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    background: var(--paper2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--ink);
    font-family: 'Lora', serif;
    font-size: 15px;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
    margin-bottom: 10px;
  }
  .nav-row:hover { border-color: var(--accent); }
  .nav-row-count {
    font-family: 'DM Mono', monospace;
    font-size: 12px;
    font-weight: 400;
    color: var(--ink3);
  }

  .tab-row {
    display: flex;
    gap: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    margin-bottom: 20px;
  }

  .tab {
    flex: 1;
    padding: 10px;
    text-align: center;
    font-size: 13px;
    font-family: 'DM Mono', monospace;
    cursor: pointer;
    background: var(--paper2);
    border: none;
    color: var(--ink3);
    transition: background 0.15s, color 0.15s;
  }

  .tab.active {
    background: var(--accent);
    color: #fff;
  }
  /* ── Install / update banner (PWA) ── */
  .pwa-banner {
    position: fixed;
    left: 12px; right: 12px;
    bottom: calc(12px + env(safe-area-inset-bottom));
    max-width: 456px;
    margin: 0 auto;
    z-index: 120; /* above the + button (z-index 100) */
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: var(--ink);
    color: var(--paper);
    border-radius: var(--radius);
    box-shadow: 0 6px 24px rgba(0,0,0,0.25);
    font-size: 14px;
    line-height: 1.35;
  }
  /* On the games list the + button lives at the bottom right: sit above it so neither covers the other */
  .pwa-banner.above-fab { bottom: calc(88px + env(safe-area-inset-bottom)); }
  .pwa-banner-text { flex: 1; min-width: 0; }
  .pwa-banner-text strong { display: block; font-weight: 600; }
  .pwa-banner-text span { opacity: 0.8; font-size: 13px; }
  .pwa-banner button {
    font: inherit;
    border: 0;
    border-radius: 8px;
    padding: 8px 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .pwa-banner .pwa-primary { background: var(--accent); color: #fff; font-weight: 600; }
  .pwa-banner .pwa-dismiss { background: transparent; color: var(--paper); opacity: 0.7; padding: 8px; }
`;

// ─── COMPONENTS ──────────────────────────────────────────────────────────────

function Toast({ msg }) {
  if (!msg) return null;
  return <div className="toast">{msg}</div>;
}

function Avatar({ username, url, size = 32 }) {
  return (
    <div
      className="player-avatar"
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)) }}
    >
      {url ? <img src={url} alt="" /> : (username || "?")[0].toUpperCase()}
    </div>
  );
}

function AuthScreen() {
  const [mode, setMode] = useState("login"); // login | signup | forgot
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  function switchMode(m) {
    setMode(m);
    setError("");
    setInfo("");
  }

  async function handleSubmit() {
    setError("");
    setInfo("");
    setLoading(true);
    try {
      if (mode === "forgot") {
        if (!email.trim()) throw new Error("Enter your email address.");
        const { error: e } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: window.location.origin,
        });
        if (e) throw e;
        setInfo("If an account exists for that email, a reset link is on its way. Check your inbox (and spam).");
      } else if (mode === "login") {
        const { error: e } = await supabase.auth.signInWithPassword({ email, password });
        if (e) throw e;
      } else {
        const un = username.trim().toLowerCase();
        if (!/^[a-z0-9_]{3,20}$/.test(un))
          throw new Error("Username: 3–20 characters, lowercase letters, numbers, underscores.");
        const { data, error: e } = await supabase.auth.signUp({
          email, password, options: { data: { username: un } },
        });
        if (e) throw e;
        if (!data.session) setError("Check your email to confirm your account, then sign in.");
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="screen">
      <div className="auth-hero">
        <div className="auth-wordmark">one<br />word<br />story</div>
        <div className="auth-sub">collaborative tales, one word at a time</div>
      </div>

      {mode !== "forgot" ? (
        <div className="tab-row">
          <button className={`tab ${mode === "login" ? "active" : ""}`} onClick={() => switchMode("login")}>Sign in</button>
          <button className={`tab ${mode === "signup" ? "active" : ""}`} onClick={() => switchMode("signup")}>Create account</button>
        </div>
      ) : (
        <div style={{ marginBottom: 20, fontSize: 14, color: "var(--ink2)" }}>
          Enter your email and we'll send you a link to reset your password.
        </div>
      )}

      {error && <div className="error-box">{error}</div>}
      {info && <div className="completed-banner">{info}</div>}

      <div className="field">
        <label>Email</label>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" />
      </div>

      {mode !== "forgot" && (
        <div className="field">
          <label>Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
        </div>
      )}

      {mode === "signup" && (
        <div className="field">
          <label>Username</label>
          <input value={username} onChange={e => setUsername(e.target.value)} placeholder="yourname" />
          <div className="username-hint">lowercase, no spaces — how others find you</div>
        </div>
      )}

      <button className="btn btn-primary" onClick={handleSubmit} disabled={loading}>
        {loading ? <span className="spinner" /> :
          mode === "login" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"}
      </button>

      {mode === "login" && (
        <div style={{ textAlign: "center", marginTop: 16 }}>
          <button className="back-btn" style={{ margin: "0 auto", fontSize: 13 }} onClick={() => switchMode("forgot")}>
            Forgot password?
          </button>
        </div>
      )}
      {mode === "forgot" && (
        <div style={{ textAlign: "center", marginTop: 16 }}>
          <button className="back-btn" style={{ margin: "0 auto", fontSize: 13 }} onClick={() => switchMode("login")}>
            ← Back to sign in
          </button>
        </div>
      )}
    </div>
  );
}

function ResetPasswordScreen({ onDone }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit() {
    setError("");
    if (password.length < 6) { setError("Password must be at least 6 characters."); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }
    setLoading(true);
    const { error: e } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (e) { setError(e.message); return; }
    window.history.replaceState(null, "", window.location.pathname); // clean the URL
    onDone();
  }

  return (
    <div className="screen">
      <div className="auth-hero">
        <div className="auth-wordmark">new<br />password</div>
        <div className="auth-sub">choose something you'll remember</div>
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="field">
        <label>New password</label>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
      </div>
      <div className="field">
        <label>Confirm password</label>
        <input
          type="password"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSubmit()}
          placeholder="••••••••"
        />
      </div>

      <button className="btn btn-primary" onClick={handleSubmit} disabled={loading}>
        {loading ? <span className="spinner" /> : "Update password"}
      </button>
    </div>
  );
}

function GameCard({ game, userId, onSelect, action }) {
  const me = getMyRow(game, userId);
  const hasLeft = !!me?.left_at;
  const active = game.status === "active";
  // Only an active game can be "your turn" (a finished story never is)
  const isMyTurn = active && !hasLeft && game.current_turn_user_id === userId;
  const tl = timeLeft(game.turn_deadline);
  const currentPlayer = game.game_players?.find(p => p.user_id === game.current_turn_user_id);
  const currentName = currentPlayer?.profiles?.username || "someone";
  const n = game.word_count || 0;
  const words = `${n} ${n === 1 ? "word" : "words"}`;

  let meta;
  if (!active) meta = words;
  else if (hasLeft) meta = `You left · ${words}`;
  else if (isMyTurn) meta = tl || "Time expired";
  else meta = `Waiting for ${currentName} · ${tl || ""}`;

  return (
    <div
      className={`game-card ${isMyTurn ? "your-turn" : ""} ${active && hasLeft ? "left-game" : ""}`}
      onClick={() => onSelect(game)}
    >
      <div className="game-card-row">
        <div>
          {isMyTurn && <div className="your-turn-badge">✦ Your turn</div>}
          <div className="game-card-title">{game.name}</div>
          <div className="game-card-meta">{meta}</div>
        </div>
        {action}
      </div>
    </div>
  );
}

function GameListScreen({ userId, username, avatarUrl, onOpenProfile, onSelectGame, onCreateGame, onRefresh, games, loading }) {
  const isLeft = g => !!getMyRow(g, userId)?.left_at;
  const visible = games.filter(g => !getMyRow(g, userId)?.archived_at && !getMyRow(g, userId)?.deleted_at);
  const myTurnGames = visible.filter(g => g.status === "active" && !isLeft(g) && g.current_turn_user_id === userId);
  const waitingGames = visible.filter(g => g.status === "active" && !isLeft(g) && g.current_turn_user_id !== userId);
  const leftGames = visible.filter(g => g.status === "active" && isLeft(g));
  const completedGames = visible.filter(g => g.status === "completed");

  const renderCards = (list) =>
    list.map(g => <GameCard key={g.id} game={g} userId={userId} onSelect={onSelectGame} />);

  return (
    <>
      <div className="header">
        <div>
          <div className="logo-mark">one word story</div>
          <div className="header-title">@{username}</div>
        </div>
        <button className="avatar-btn" onClick={onOpenProfile} aria-label="Profile and settings">
          <Avatar username={username} url={avatarUrl} size={40} />
        </button>
      </div>

      <div className="screen">
        {loading ? (
          <div className="empty-state"><span className="spinner" /></div>
        ) : visible.length === 0 ? (
          <div className="empty-state">No games yet.<br />Start one with the + button.</div>
        ) : (
          <>
            {myTurnGames.length > 0 && (<><div className="section-label">Your turn</div>{renderCards(myTurnGames)}</>)}
            {waitingGames.length > 0 && (<><div className="section-label">Waiting</div>{renderCards(waitingGames)}</>)}
            {leftGames.length > 0 && (<><div className="section-label">Left</div>{renderCards(leftGames)}</>)}
            {completedGames.length > 0 && (<><div className="section-label">Completed</div>{renderCards(completedGames)}</>)}
          </>
        )}

        <div className="refresh-row">
          <button className="refresh-btn" onClick={onRefresh}>↻ Refresh</button>
        </div>
      </div>

      <button className="fab" onClick={onCreateGame}>+</button>
    </>
  );
}

function ArchiveScreen({ userId, games, onBack, onSelectGame, onUnarchive }) {
  const archived = games.filter(g => g.status === "completed" && getMyRow(g, userId)?.archived_at);
  return (
    <>
      <div className="header">
        <button className="back-btn" onClick={onBack}>← Profile</button>
        <div className="header-title">Archived stories</div>
        <div style={{ width: 60 }} />
      </div>
      <div className="screen">
        {archived.length === 0 ? (
          <div className="empty-state">No archived stories.<br />Archive a finished story to tuck it away here.</div>
        ) : (
          archived.map(g => (
            <GameCard
              key={g.id}
              game={g}
              userId={userId}
              onSelect={onSelectGame}
              action={
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={e => { e.stopPropagation(); onUnarchive(g.id); }}
                >
                  Unarchive
                </button>
              }
            />
          ))
        )}
      </div>
    </>
  );
}

function NotificationsSetting({ toast }) {
  const SUPPORTED = pushSupported();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const denied = SUPPORTED && Notification.permission === "denied";

  useEffect(() => {
    let alive = true;
    if (SUPPORTED) isPushEnabled().then(v => { if (alive) setOn(v); }).catch(() => {});
    return () => { alive = false; };
  }, [SUPPORTED]);

  async function toggle(e) {
    const want = e.target.checked;
    setBusy(true); setMsg("");
    try {
      if (want) { await enablePush(supabase, SUPABASE_URL, SUPABASE_ANON_KEY); setOn(true); toast?.("Notifications on"); }
      else { await disablePush(supabase); setOn(false); toast?.("Notifications off"); }
    } catch (err) {
      setMsg(err.message || "Couldn't change notifications.");
      setOn(await isPushEnabled().catch(() => false));
    } finally { setBusy(false); }
  }

  async function test() {
    setBusy(true); setMsg("");
    try { await sendTestPush(supabase); toast?.("Test sent. It should arrive in a few seconds."); }
    catch (err) { setMsg(err.message || "Couldn't send the test."); }
    finally { setBusy(false); }
  }

  if (SUPPORTED && !pushAllowedHere()) {
    return (
      <div className="setting-row">
        <div>
          <div className="setting-title">Notify me on my turn</div>
          <div className="setting-hint">Only available in the installed app at {PUSH_ORIGIN.replace("https://", "")}, not on test copies of the site.</div>
        </div>
      </div>
    );
  }

  if (!SUPPORTED) {
    return (
      <div className="setting-row">
        <div>
          <div className="setting-title">Notify me on my turn</div>
          <div className="setting-hint">
            {isIOSDevice() && !isInstalledApp()
              ? "On iPhone, first tap Share (in Safari or Chrome), then “Add to Home Screen”. Open the app from the new icon and turn this on there."
              : "This browser can't receive notifications. Try installing the app from Chrome."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <label className="setting-row">
        <input type="checkbox" checked={on} disabled={busy || denied} onChange={toggle} />
        <div>
          <div className="setting-title">Notify me on my turn</div>
          <div className="setting-hint">
            {denied
              ? "Notifications are blocked for this app. Allow them in your phone's settings for One Word Story, then come back."
              : "A message when it's your turn, when you're added to a story, or when one finishes. Per device."}
          </div>
        </div>
      </label>
      {on && <button className="btn btn-ghost" style={{ marginBottom: 8 }} disabled={busy} onClick={test}>Send me a test notification</button>}
      {msg && <div className="error-box">{msg}</div>}
    </>
  );
}

function ProfileScreen({ userId, profile, email, pendingEmail, onBack, onProfileUpdated, soundEnabled, onSoundChange, archivedCount, onOpenArchive }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const fileRef = useRef(null);
  const path = `${userId}/avatar.jpg`;
  const [nameInput, setNameInput] = useState(profile.username);
  const [emailInput, setEmailInput] = useState("");
  const [pendingLocal, setPendingLocal] = useState(pendingEmail || "");
  const [savingName, setSavingName] = useState(false);
  const [savingEmail, setSavingEmail] = useState(false);
  const [acctError, setAcctError] = useState("");
  const [acctInfo, setAcctInfo] = useState("");
  const [hl, setHl] = useState(getHighlight);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2000);
  };

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("Choose an image file."); return; }
    if (file.size > 15 * 1024 * 1024) { setError("That image is over 15 MB. Choose a smaller one."); return; }
    setError("");
    setUploading(true);
    try {
      const blob = await resizeImageToBlob(file);
      const { error: ue } = await supabase.storage
        .from("avatars")
        .upload(path, blob, { upsert: true, contentType: "image/jpeg", cacheControl: "3600" });
      if (ue) throw ue;
      const { data: pub } = supabase.storage.from("avatars").getPublicUrl(path);
      const url = `${pub.publicUrl}?v=${Date.now()}`; // bust caches after replacing
      const { error: pe } = await supabase.from("profiles").update({ avatar_url: url }).eq("id", userId);
      if (pe) throw pe;
      onProfileUpdated({ ...profile, avatar_url: url });
      showToast("Photo updated");
    } catch (err) {
      setError(err.message || "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function handleRemove() {
    setError("");
    setUploading(true);
    try {
      await supabase.storage.from("avatars").remove([path]);
      const { error: pe } = await supabase.from("profiles").update({ avatar_url: null }).eq("id", userId);
      if (pe) throw pe;
      onProfileUpdated({ ...profile, avatar_url: null });
      showToast("Photo removed");
    } catch (err) {
      setError(err.message || "Could not remove photo.");
    } finally {
      setUploading(false);
    }
  }

  async function handleUsernameSave() {
    setAcctError("");
    setAcctInfo("");
    const un = nameInput.trim().toLowerCase();
    if (un === profile.username) { setAcctError("That's already your username."); return; }
    if (!/^[a-z0-9_]{3,20}$/.test(un)) {
      setAcctError("Username: 3–20 characters, lowercase letters, numbers, underscores.");
      return;
    }
    setSavingName(true);
    const { error: ue } = await supabase.rpc("change_username", { p_username: un });
    setSavingName(false);
    if (ue) { setAcctError(ue.message); return; }
    setNameInput(un);
    onProfileUpdated({ ...profile, username: un });
    showToast("Username updated");
  }

  async function handleEmailSave() {
    setAcctError("");
    setAcctInfo("");
    const next = emailInput.trim();
    if (!/^\S+@\S+\.\S+$/.test(next)) { setAcctError("Enter a valid email address."); return; }
    if (next.toLowerCase() === (email || "").toLowerCase()) { setAcctError("That's already your email address."); return; }
    setSavingEmail(true);
    const { data, error: ee } = await supabase.auth.updateUser(
      { email: next },
      { emailRedirectTo: window.location.origin }
    );
    setSavingEmail(false);
    if (ee) { setAcctError(ee.message); return; }
    setPendingLocal(data?.user?.new_email || next);
    setEmailInput("");
    setAcctInfo("Check your inbox for a confirmation link. Your email won't change until you confirm it, and you may be asked to confirm from your current address too.");
  }

  function updateHighlight(patch) {
    const next = { ...hl, ...patch };
    setHl(next);
    saveHighlight(next);
    applyHighlight(next);
  }

  function handleSoundToggle(e) {
    const on = e.target.checked;
    onSoundChange(on);
    if (on) playBell(); // preview, and the tap also unlocks audio
  }

  return (
    <>
      <div className="header">
        <button className="back-btn" onClick={onBack}>← Games</button>
        <div className="header-title">Profile</div>
        <div style={{ width: 60 }} />
      </div>
      <div className="screen">
        {error && <div className="error-box">{error}</div>}

        <div className="profile-hero">
          <Avatar username={profile.username} url={profile.avatar_url} size={96} />
          <div className="profile-name">@{profile.username}</div>
          <div className="profile-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? <span className="spinner" /> : profile.avatar_url ? "Change photo" : "Upload photo"}
            </button>
            {profile.avatar_url && (
              <button className="btn btn-ghost btn-sm" onClick={handleRemove} disabled={uploading}>Remove</button>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} style={{ display: "none" }} />
        </div>

        <div className="section-label">Account</div>
        {acctError && <div className="error-box">{acctError}</div>}
        {acctInfo && <div className="completed-banner">{acctInfo}</div>}

        <div className="field">
          <label>Username</label>
          <div className="inline-form">
            <input
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleUsernameSave()}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleUsernameSave}
              disabled={savingName || !nameInput.trim() || nameInput.trim().toLowerCase() === profile.username}
            >
              {savingName ? <span className="spinner" /> : "Save"}
            </button>
          </div>
          <div className="username-hint">3–20 characters: lowercase letters, numbers, underscores</div>
        </div>

        <div className="field">
          <label>Email</label>
          <div className="username-hint" style={{ margin: "0 0 8px" }}>Current: {email}</div>
          <div className="inline-form">
            <input
              type="email"
              value={emailInput}
              onChange={e => setEmailInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleEmailSave()}
              placeholder="new email address"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
            />
            <button className="btn btn-ghost btn-sm" onClick={handleEmailSave} disabled={savingEmail || !emailInput.trim()}>
              {savingEmail ? <span className="spinner" /> : "Update"}
            </button>
          </div>
          {pendingLocal && (
            <div className="username-hint">Waiting for you to confirm {pendingLocal}</div>
          )}
        </div>

        <div className="section-label">Stories</div>
        <button className="nav-row" onClick={onOpenArchive}>
          <span>Archived stories</span>
          <span className="nav-row-count">{archivedCount} ›</span>
        </button>

        <div className="section-label">Settings</div>
        <label className="setting-row">
          <input type="checkbox" checked={soundEnabled} onChange={handleSoundToggle} />
          <div>
            <div className="setting-title">Play a bell on my turn</div>
            <div className="setting-hint">Rings while the app is open. Saved on this device.</div>
          </div>
        </label>
        <NotificationsSetting toast={showToast} />

        <div className="section-label">My words in stories</div>
        <div className="story-box" style={{ minHeight: 0, padding: "14px 18px", marginBottom: 12, fontSize: 18 }}>
          <span className="word-chip">Once upon a</span>{" "}
          <span className="word-chip mine">time,</span>{" "}
          <span className="word-chip">there lived</span>{" "}
          <span className="word-chip mine">a</span>
        </div>
        <div className="format-row">
          {HIGHLIGHT_COLORS.map(c => (
            <button
              key={c.value}
              type="button"
              className={`fmt-btn ${hl.color.toLowerCase() === c.value ? "on" : ""}`}
              aria-pressed={hl.color.toLowerCase() === c.value}
              onClick={() => updateHighlight({ color: c.value })}
            >
              <span className="hl-dot" style={{ background: c.value }} />{c.name}
            </button>
          ))}
        </div>
        <label className="hl-custom">
          <input type="color" value={hl.color} onChange={e => updateHighlight({ color: e.target.value })} />
          Pick any color
        </label>
        <div className="format-row">
          {HIGHLIGHT_STYLES.map(st => (
            <button
              key={st.id}
              type="button"
              className={`fmt-btn ${hl.style === st.id ? "on" : ""}`}
              aria-pressed={hl.style === st.id}
              onClick={() => updateHighlight({ style: st.id })}
            >{st.label}</button>
          ))}
        </div>
        <div className="setting-hint" style={{ marginBottom: 10 }}>
          Underline and Highlighter make your words stand out without relying on color. Saved on this device.
        </div>

        <div style={{ marginTop: 24 }}>
          <button className="btn btn-ghost" onClick={async () => { await disablePush(supabase).catch(() => {}); await supabase.auth.signOut(); }}>Sign out</button>
        </div>
      </div>
      <Toast msg={toast} />
    </>
  );
}

function AddPlayerInput({ excludeIds, onPick, onError }) {
  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [show, setShow] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const reqId = useRef(0);

  // Look up usernames starting with what's been typed (debounced; stale replies are ignored)
  useEffect(() => {
    const q = input.trim().toLowerCase();
    if (!q) { setSuggestions([]); return; }
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      const escaped = q.replace(/[%_]/g, "\\$&"); // _ is valid in usernames, so don't treat it as a wildcard
      const { data } = await supabase
        .from("profiles")
        .select("id, username, avatar_url")
        .ilike("username", `${escaped}%`)
        .order("username")
        .limit(10);
      if (id !== reqId.current) return;
      setSuggestions(data || []);
      setActiveIdx(-1);
    }, 200);
    return () => clearTimeout(t);
  }, [input]);

  // Hide anyone who's already in the game
  const visible = suggestions.filter(u => !excludeIds.includes(u.id)).slice(0, 6);

  async function pick(profile) {
    setInput("");
    setSuggestions([]);
    setShow(false);
    await onPick(profile);
  }

  async function addTyped() {
    const un = input.trim().toLowerCase();
    if (!un) return;
    const { data } = await supabase
      .from("profiles").select("id, username, avatar_url").eq("username", un).maybeSingle();
    if (!data) { onError(`User "${un}" not found`); return; }
    if (excludeIds.includes(data.id)) { onError("Already in this game"); return; }
    pick(data);
  }

  function onKeyDown(e) {
    if (e.key === "ArrowDown" && visible.length) {
      e.preventDefault(); setShow(true); setActiveIdx(i => (i + 1) % visible.length);
    } else if (e.key === "ArrowUp" && visible.length) {
      e.preventDefault(); setActiveIdx(i => (i <= 0 ? visible.length - 1 : i - 1));
    } else if (e.key === "Escape") {
      setShow(false);
    } else if (e.key === "Enter") {
      if (show && activeIdx >= 0 && visible[activeIdx]) pick(visible[activeIdx]);
      else addTyped();
    }
  }

  return (
    <div className="word-input-row">
      <div className="field suggest-wrap">
        <input
          value={input}
          onChange={e => { setInput(e.target.value); setShow(true); }}
          onFocus={() => setShow(true)}
          onBlur={() => setTimeout(() => setShow(false), 150)}
          onKeyDown={onKeyDown}
          placeholder="add by username…"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        {show && visible.length > 0 && (
          <ul className="suggest-list" role="listbox">
            {visible.map((u, i) => {
              const typed = input.trim().length;
              return (
                <li
                  key={u.id}
                  role="option"
                  aria-selected={i === activeIdx}
                  className={`suggest-item ${i === activeIdx ? "active" : ""}`}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => pick(u)}
                >
                  <Avatar username={u.username} url={u.avatar_url} size={28} />
                  <span>
                    <span className="suggest-match">{u.username.slice(0, typed)}</span>
                    {u.username.slice(typed)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <button className="btn btn-ghost btn-sm" onClick={addTyped}>Add</button>
    </div>
  );
}

// Preset lengths plus a "Custom" option with exact minutes and seconds. Reports the total in seconds.
function TurnTimePicker({ value, onChange }) {
  const [custom, setCustom] = useState(!TURN_PRESETS.includes(value));
  const [mins, setMins] = useState(String(Math.floor(value / 60)));
  const [secs, setSecs] = useState(String(value % 60));
  const toTotal = (m, s) => (parseInt(m, 10) || 0) * 60 + (parseInt(s, 10) || 0);
  const digits = (v) => v.replace(/\D/g, "").slice(0, 5);

  function onSelect(e) {
    if (e.target.value === "custom") {
      setCustom(true);
      onChange(toTotal(mins, secs));
    } else {
      setCustom(false);
      onChange(Number(e.target.value));
    }
  }

  const total = toTotal(mins, secs);
  return (
    <div>
      <select value={custom ? "custom" : String(value)} onChange={onSelect} aria-label="Time per turn">
        {TURN_PRESETS.map(sec => <option key={sec} value={sec}>{formatDuration(sec)}</option>)}
        <option value="custom">Custom…</option>
      </select>
      {custom && (
        <>
          <div className="duration-row">
            <div>
              <label>Minutes</label>
              <input
                inputMode="numeric"
                value={mins}
                onChange={e => { const v = digits(e.target.value); setMins(v); onChange(toTotal(v, secs)); }}
                aria-label="Minutes"
              />
            </div>
            <div>
              <label>Seconds</label>
              <input
                inputMode="numeric"
                value={secs}
                onChange={e => { const v = digits(e.target.value); setSecs(v); onChange(toTotal(mins, v)); }}
                aria-label="Seconds"
              />
            </div>
          </div>
          <div className="username-hint" style={validTurnSeconds(total) ? undefined : { color: "var(--accent)" }}>
            {validTurnSeconds(total)
              ? `Each turn lasts ${formatDuration(total)}`
              : "Choose between 10 seconds and 7 days (10,080 minutes)"}
          </div>
        </>
      )}
    </div>
  );
}

function CreateGameScreen({ userId, onBack, onCreated }) {
  const [name, setName] = useState("");
  const [timeLimit, setTimeLimit] = useState(86400); // seconds
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function addProfile(profile) {
    if (profile.id === userId) { setError("You're already in the game"); return; }
    if (players.some(p => p.id === profile.id)) { setError("Already added"); return; }
    setPlayers(p => [...p, profile]);
    setError("");
  }

  async function createGame() {
    if (!name.trim()) { setError("Enter a game name"); return; }
    if (!validTurnSeconds(timeLimit)) { setError("Turn time must be between 10 seconds and 7 days."); return; }
    setLoading(true);
    setError("");
    try {
      const gameId = await rpc("create_game", {
        p_name: name.trim(),
        p_seconds: timeLimit,
        p_player_ids: players.map(p => p.id),
      });
      onCreated(gameId);
    } catch (e) {
      setError(e.message);
      setLoading(false);
    }
  }

  return (
    <>
      <div className="header">
        <button className="back-btn" onClick={onBack}>← Back</button>
        <div className="header-title">New game</div>
        <div style={{ width: 60 }} />
      </div>
      <div className="screen">
        {error && <div className="error-box">{error}</div>}

        <div className="field">
          <label>Game name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="The Great Adventure" />
        </div>

        <div className="field">
          <label>Time per turn</label>
          <TurnTimePicker value={timeLimit} onChange={setTimeLimit} />
        </div>

        <div className="section-label">Players</div>
        <div className="player-row">
          <div className="player-avatar">you</div>
          <span className="player-name">You (creator)</span>
        </div>
        {players.map((p, i) => (
          <div className="player-row" key={p.id}>
            <Avatar username={p.username} url={p.avatar_url} />
            <span className="player-name">@{p.username}</span>
            <button className="remove-btn" onClick={() => setPlayers(ps => ps.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}

        <div style={{ marginBottom: 8 }}>
          <AddPlayerInput
            excludeIds={[userId, ...players.map(p => p.id)]}
            onPick={addProfile}
            onError={setError}
          />
        </div>

        <button className="btn btn-primary" onClick={createGame} disabled={loading}>
          {loading ? <span className="spinner" /> : "Create game"}
        </button>
      </div>
    </>
  );
}

function GamePlayScreen({ gameId, userId, onBack }) {
  const [game, setGame] = useState(null);
  const [words, setWords] = useState([]);
  const [wordInput, setWordInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [addError, setAddError] = useState("");
  const [bold, setBold] = useState(false);
  const [italic, setItalic] = useState(false);
  const [brk, setBrk] = useState("none"); // "none" | "line" | "para"
  const [undoUntil, setUndoUntil] = useState(0); // ms timestamp; the undo button shows until then
  const [undoLeft, setUndoLeft] = useState(0);
  const [undoing, setUndoing] = useState(false);
  const [draftSeconds, setDraftSeconds] = useState(null); // turn time being edited, not yet saved
  const [applyingTime, setApplyingTime] = useState(false);
  const lastAdvanceRef = useRef(0);
  const [, setNow] = useState(Date.now()); // forces re-render so the countdown updates

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2000);
  };

  // advance=true also skips expired turns; live updates pass false (just re-read)
  const loadGame = useCallback(async (advance = true) => {
    const { data: g } = await supabase
      .from("games")
      .select("*, game_players(*, profiles(username, avatar_url))")
      .eq("id", gameId)
      .single();

    if (g) {
      if (advance && g.status === "active" && g.turn_deadline && new Date() > new Date(g.turn_deadline)) {
        await advanceIfExpired(g.id).catch(() => {}); // another phone may have just done it; either way we re-read next
        const { data: gFresh } = await supabase
          .from("games")
          .select("*, game_players(*, profiles(username, avatar_url))")
          .eq("id", gameId)
          .single();
        setGame(gFresh);
      } else {
        setGame(g);
      }
    }

    const { data: w } = await supabase
      .from("story_words")
      .select("*, profiles(username)")
      .eq("game_id", gameId)
      .order("word_order");

    setWords(w || []);
    setLoading(false);
  }, [gameId]);

  useEffect(() => { loadGame(true); }, [loadGame]);

  // Discard an unsaved timer edit whenever the saved value changes
  useEffect(() => { setDraftSeconds(null); }, [game?.turn_time_limit_seconds]);

  // Undo countdown (30 seconds after submitting a word)
  useEffect(() => {
    if (!undoUntil) return;
    const tick = () => {
      const left = Math.ceil((undoUntil - Date.now()) / 1000);
      if (left <= 0) { setUndoUntil(0); setUndoLeft(0); } else setUndoLeft(left);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [undoUntil]);

  // Once a turn is under 10 minutes from its deadline, tick every second and skip it the moment it expires
  useEffect(() => {
    const id = setInterval(() => {
      if (!game || game.status !== "active" || !game.turn_deadline) return;
      const left = new Date(game.turn_deadline).getTime() - Date.now();
      if (left < 600000) {
        setNow(Date.now());
        if (left <= 0 && Date.now() - lastAdvanceRef.current > 5000) {
          lastAdvanceRef.current = Date.now();
          loadGame(true);
        }
      }
    }, 1000);
    return () => clearInterval(id);
  }, [game, loadGame]);

  // Live updates: re-read whenever this game or its words change
  useEffect(() => {
    const channel = supabase
      .channel(`game-${gameId}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "story_words", filter: `game_id=eq.${gameId}` },
        () => loadGame(false))
      .on("postgres_changes",
        { event: "*", schema: "public", table: "games", filter: `id=eq.${gameId}` },
        () => loadGame(false))
      .on("postgres_changes",
        { event: "*", schema: "public", table: "game_players", filter: `game_id=eq.${gameId}` },
        () => loadGame(false))
      .subscribe();

    // Phones drop sockets when the tab sleeps, so catch up when it wakes
    const onVisible = () => { if (document.visibilityState === "visible") loadGame(true); };
    document.addEventListener("visibilitychange", onVisible);

    // Every 30s: refresh the countdown, and skip the turn if it just expired
    const tick = setInterval(() => {
      setNow(Date.now());
      loadGame(true);
    }, 30000);

    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(tick);
    };
  }, [gameId, loadGame]);

  async function handleSubmit() {
    if (!wordInput.trim()) return;
    setError("");
    setSubmitting(true);
    try {
      await submitWord(game, wordInput.trim(), {
        bold,
        italic,
        break_before: words.length ? brk : "none",
      });
      setWordInput("");
      setBold(false);
      setItalic(false);
      setBrk("none");
      setUndoUntil(Date.now() + 30000);
      showToast("Word added!");
      await loadGame();
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  // New players go to the end of the queue; someone who left comes back at the end too (the server decides)
  async function handleAddPlayer(profile) {
    setAddError("");
    try {
      await rpc("add_player", { p_game: gameId, p_user: profile.id });
      showToast(`@${profile.username} added`);
      setShowAdd(false);
      await loadGame(false);
    } catch (e) {
      setAddError(e.message);
    }
  }

  async function handleLeave() {
    if (!confirm("Leave this story? Your words stay in the story, and you can rejoin later at the end of the queue.")) return;
    setError("");
    const { error: e } = await supabase.rpc("leave_game", { p_game: gameId });
    if (e) { setError(e.message); return; }
    showToast("You left the game");
    await loadGame(false);
  }

  async function handleRejoin() {
    setError("");
    const { error: e } = await supabase.rpc("rejoin_game", { p_game: gameId });
    if (e) { setError(e.message); return; }
    showToast("You're back in, at the end of the queue");
    await loadGame(false);
  }

  async function handleArchive(archive) {
    const { error: e } = await supabase.rpc("set_game_archived", { p_game: gameId, p_archived: archive });
    if (e) { showToast(e.message); return; }
    if (archive) { onBack(); return; } // back to wherever we came from; App reloads the list
    showToast("Moved out of the archive");
    await loadGame(false);
  }

  async function handleReopen() {
    if (!confirm("Reopen this story?\n\nIt becomes active again and the next player is notified.")) return;
    const { error: e } = await supabase.rpc("reopen_story", { p_game: gameId });
    if (e) { showToast(e.message); return; }
    showToast("Story reopened");
    await loadGame(false);
  }

  async function handleDeleteStory() {
    if (!confirm("Delete this story from your list?\n\nThe other players keep their copy, but you won't be able to get it back.")) return;
    const { error: e } = await supabase.rpc("delete_story_for_me", { p_game: gameId });
    if (e) { showToast(e.message); return; }
    onBack(); // back to the list; App reloads it, and the story is gone
  }

  async function handleUndo() {
    setError("");
    setUndoing(true);
    const { data, error: ue } = await supabase.rpc("undo_last_word", { p_game: gameId });
    setUndoing(false);
    setUndoUntil(0);
    if (ue) { setError(ue.message); return; }
    if (data) { // put the word back in the box so it can be edited
      setWordInput(data.word_text || "");
      setBold(!!data.bold);
      setItalic(!!data.italic);
      setBrk(data.break_before || "none");
    }
    showToast("Word taken back");
    await loadGame(false);
  }

  async function handleApplyTime() {
    if (!validTurnSeconds(draftSeconds)) return;
    setApplyingTime(true);
    const { error: te } = await supabase.rpc("set_turn_time_limit", { p_game: gameId, p_seconds: draftSeconds });
    setApplyingTime(false);
    if (te) { showToast(te.message); return; }
    showToast("Turn time updated");
    await loadGame(false);
  }

  async function handleEndGame() {
    if (!confirm("End this story?")) return;
    setError("");
    try {
      await rpc("end_game", { p_game: gameId });
      showToast("Story completed!");
      await loadGame();
    } catch (e) {
      setError(e.message);
    }
  }

  async function copyStory() {
    await navigator.clipboard.writeText(storyText(words));
    showToast("Copied to clipboard!");
  }

  if (loading) return (
    <>
      <div className="header">
        <button className="back-btn" onClick={onBack}>← Back</button>
      </div>
      <div className="screen empty-state"><span className="spinner" /></div>
    </>
  );

  if (!game) return null;

  const me = getMyRow(game, userId);
  const hasLeft = !!me?.left_at;
  const isArchived = !!me?.archived_at;
  const REOPEN_MS = 24 * 60 * 60 * 1000;
  const reopenMsLeft = game.status === "completed" && game.completed_at
    ? new Date(game.completed_at).getTime() + REOPEN_MS - Date.now() : 0;
  const reopenHoursLeft = Math.max(1, Math.ceil(reopenMsLeft / 3600000));
  const canReopen = reopenMsLeft > 0 && !!me && !hasLeft;
  const isMyTurn = game.current_turn_user_id === userId && game.status === "active" && !hasLeft;
  const currentPlayer = game.game_players?.find(p => p.user_id === game.current_turn_user_id);
  const currentPlayerName = currentPlayer?.profiles?.username || "someone";
  const tl = timeLeft(game.turn_deadline);
  const playerOrder = [...(game.game_players || [])].sort(
    (a, b) => (!!a.left_at - !!b.left_at) || a.player_order - b.player_order
  ); // active players in turn order, then anyone who left
  const currentSeconds = turnSeconds(game);
  const lastWord = words[words.length - 1];
  const canUndo = game.status === "active" && undoLeft > 0 && lastWord?.user_id === userId;

  return (
    <>
      <div className="header" style={{ gap: 10 }}>
        <button className="back-btn" onClick={onBack} style={{ flexShrink: 0 }}>← Games</button>
        <div className="header-title" style={{ flex: 1, minWidth: 0, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{game.name}</div>
        <button className="btn btn-ghost btn-sm" onClick={copyStory} style={{ flexShrink: 0 }}>Copy</button>
      </div>

      <div className="screen">
        {game.status === "completed" && (
          <div className="completed-banner">This story is complete.</div>
        )}

        <div className="story-box">
          {words.length === 0
            ? <span className="story-empty">The story begins…</span>
            : words.map((w, i) => {
              const { tail, body } = splitEntry(w.word_text);
              const attach = tail && i > 0; // tail glues to the previous word
              const sep =
                i === 0 ? null
                : w.break_before === "para" ? <span className="para-break" />
                : w.break_before === "line" ? <br />
                : " ";
              return (
                <span key={w.id} className={`word-chip ${w.user_id === userId ? "mine" : ""}`}>
                  {attach ? tail : ""}
                  {sep}
                  <span className={`${w.bold ? "w-bold" : ""} ${w.italic ? "w-italic" : ""}`}>{body}</span>
                </span>
              );
            })}
        </div>

        <div className="story-meta">{words.length} {words.length === 1 ? "word" : "words"}</div>

        {game.status === "completed" && me && (
          <div className="action-row">
            {canReopen && (
              <button className="btn btn-primary btn-sm reopen-btn" onClick={handleReopen}>Reopen story · {reopenHoursLeft}h left</button>
            )}
            {!isArchived && <button className="btn-danger" onClick={handleDeleteStory}>Delete story</button>}
            <button className="btn btn-ghost btn-sm" onClick={() => handleArchive(!isArchived)}>
              {isArchived ? "Unarchive" : "Archive story"}
            </button>
          </div>
        )}

        {game.status === "active" && (
          <>
            <div className={`turn-status ${isMyTurn ? "my-turn" : "waiting"}`}>
              <div className="turn-status-name">
                {hasLeft ? "You left this game" : isMyTurn ? "Your turn" : `Waiting for @${currentPlayerName}`}
              </div>
              {tl && <div className="turn-status-time">{tl}</div>}
            </div>

            {error && <div className="error-box">{error}</div>}

            {hasLeft && (
              <div className="end-game-row" style={{ marginBottom: 12 }}>
                <button className="btn btn-primary btn-sm" onClick={handleRejoin}>Rejoin (end of queue)</button>
              </div>
            )}

            {!isMyTurn && canUndo && (
              <div className="undo-row">
                <span>Your word was added.</span>
                <button className="btn btn-ghost btn-sm" onClick={handleUndo} disabled={undoing}>
                  {undoing ? <span className="spinner" /> : `↶ Undo (${undoLeft}s)`}
                </button>
              </div>
            )}

            {isMyTurn && (
              <div className="word-input-row">
                <div className="field">
                  <input
                    value={wordInput}
                    onChange={e => setWordInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleSubmit()}
                    placeholder="one word…"
                    style={{ fontWeight: bold ? 700 : 400, fontStyle: italic ? "italic" : "normal" }}
                    autoFocus
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </div>
                <button className="btn btn-primary" onClick={handleSubmit} disabled={submitting || !wordInput.trim()}>
                  {submitting ? <span className="spinner" /> : "Add"}
                </button>
              </div>
            )}

            {isMyTurn && (
              <div className="format-row">
                <button
                  type="button"
                  className={`fmt-btn ${bold ? "on" : ""}`}
                  style={{ fontWeight: 700 }}
                  aria-pressed={bold}
                  aria-label="Bold"
                  onClick={() => setBold(b => !b)}
                >B</button>
                <button
                  type="button"
                  className={`fmt-btn ${italic ? "on" : ""}`}
                  style={{ fontStyle: "italic" }}
                  aria-pressed={italic}
                  aria-label="Italic"
                  onClick={() => setItalic(v => !v)}
                >I</button>
                <button
                  type="button"
                  className={`fmt-btn ${brk === "line" ? "on" : ""}`}
                  aria-pressed={brk === "line"}
                  disabled={!words.length}
                  onClick={() => setBrk(b => (b === "line" ? "none" : "line"))}
                >↵ Line break</button>
                <button
                  type="button"
                  className={`fmt-btn ${brk === "para" ? "on" : ""}`}
                  aria-pressed={brk === "para"}
                  disabled={!words.length}
                  onClick={() => setBrk(b => (b === "para" ? "none" : "para"))}
                >¶ New paragraph</button>
              </div>
            )}

            {isMyTurn && (
              <div className="username-hint" style={{ marginBottom: 12 }}>
                Up to 2 punctuation marks before and after your word. Start with &quot;. &quot; to end the previous sentence. A break starts your word on a new line or paragraph.
              </div>
            )}

          </>
        )}

        <div className="play-nav-row">
          <button className="btn btn-ghost btn-sm" onClick={onBack}>← Games</button>
          <button className="refresh-btn" onClick={() => loadGame(true)}>↻ Refresh</button>
        </div>

        <div className="section-label" style={{ marginTop: 24 }}>Players</div>
        {playerOrder?.map(p => (
          <div className={`player-row ${p.left_at ? "left" : ""}`} key={p.user_id}>
            <Avatar username={p.profiles?.username} url={p.profiles?.avatar_url} />
            <span className="player-name">@{p.profiles?.username}</span>
            {p.left_at && <span className="left-tag">left</span>}
            {!p.left_at && p.user_id === game.current_turn_user_id && game.status === "active" && (
              <span style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: "var(--accent)", background: "color-mix(in srgb, var(--accent) 10%, transparent)", padding: "2px 8px", borderRadius: 99 }}>
                current
              </span>
            )}
          </div>
        ))}

        {game.status === "active" && !hasLeft && (
          <div style={{ marginTop: 12 }}>
            {!showAdd ? (
              <button className="btn btn-ghost btn-sm" onClick={() => setShowAdd(true)}>
                + Add player
              </button>
            ) : (
              <>
                {addError && <div className="error-box">{addError}</div>}
                <AddPlayerInput
                  excludeIds={playerOrder.filter(p => !p.left_at).map(p => p.user_id)}
                  onPick={handleAddPlayer}
                  onError={setAddError}
                />
                <button
                  className="back-btn"
                  style={{ fontSize: 13 }}
                  onClick={() => { setShowAdd(false); setAddError(""); }}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        )}

        {game.status === "active" && !hasLeft && (
          <>
            <div className="section-label" style={{ marginTop: 24 }}>Turn timer</div>
            <div className="field" style={{ marginBottom: 8 }}>
              <TurnTimePicker key={currentSeconds} value={draftSeconds ?? currentSeconds} onChange={setDraftSeconds} />
            </div>
            {draftSeconds != null && draftSeconds !== currentSeconds && (
              <button
                className="btn btn-primary btn-sm"
                onClick={handleApplyTime}
                disabled={applyingTime || !validTurnSeconds(draftSeconds)}
              >
                {applyingTime ? <span className="spinner" /> : "Update turn time"}
              </button>
            )}
            <div className="username-hint">Saving also adjusts the current turn's clock.</div>
          </>
        )}

        {game.status === "active" && !hasLeft && (
          <div className="end-game-row" style={{ marginTop: 28 }}>
            <button className="btn-danger" onClick={handleLeave}>Leave game</button>
            <button className="btn-danger" onClick={handleEndGame}>End story</button>
          </div>
        )}
      </div>

      <Toast msg={toast} />
    </>
  );
}

// ─── APP ─────────────────────────────────────────────────────────────────────
// ───────── Install / update banners (PWA) ─────────
const INSTALL_DISMISSED_KEY = "ows-install-dismissed";
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function isIOS() {
  // iPadOS reports itself as a Mac, so also check for touch support
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function installDismissed() {
  try { return localStorage.getItem(INSTALL_DISMISSED_KEY) === "1"; } catch { return false; }
}

function PwaBanners({ showInstall, aboveFab }) {
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW();
  const [installEvent, setInstallEvent] = useState(null);
  const [dismissed, setDismissed] = useState(installDismissed);

  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); setInstallEvent(e); };
    const onInstalled = () => setInstallEvent(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  function dismiss() {
    setDismissed(true);
    try { localStorage.setItem(INSTALL_DISMISSED_KEY, "1"); } catch { /* private mode: fine */ }
  }

  if (needRefresh) {
    return (
      <div className={`pwa-banner ${aboveFab ? "above-fab" : ""}`} role="status">
        <div className="pwa-banner-text"><strong>Update available</strong><span>A new version of One Word Story is ready.</span></div>
        <button className="pwa-primary" onClick={() => updateServiceWorker(true)}>Update</button>
      </div>
    );
  }

  if (!showInstall || dismissed || isStandalone()) return null;

  if (installEvent) {
    return (
      <div className={`pwa-banner ${aboveFab ? "above-fab" : ""}`} role="status">
        <div className="pwa-banner-text"><strong>Install One Word Story</strong><span>Add it to your home screen to get notified on your turn.</span></div>
        <button className="pwa-primary" onClick={async () => {
          installEvent.prompt();
          await installEvent.userChoice.catch(() => {});
          setInstallEvent(null);
        }}>Install</button>
        <button className="pwa-dismiss" onClick={dismiss} aria-label="Dismiss">✕</button>
      </div>
    );
  }

  if (isIOS()) {
    return (
      <div className={`pwa-banner ${aboveFab ? "above-fab" : ""}`} role="status">
        <div className="pwa-banner-text"><strong>Install on your iPhone</strong><span>Tap the Share button in your browser (Safari or Chrome), then “Add to Home Screen”.</span></div>
        <button className="pwa-dismiss" onClick={dismiss} aria-label="Dismiss">✕</button>
      </div>
    );
  }

  return null;
}

export default function App() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [screen, setScreen] = useState("list");
  const [selectedGameId, setSelectedGameId] = useState(null);

  // Every screen change pushes a history entry, so the browser/phone Back button steps back through screens
  const navigate = useCallback((next, { gameId = null, replace = false } = {}) => {
    const state = { ows: true, screen: next, gameId };
    if (replace) window.history.replaceState(state, "");
    else window.history.pushState(state, "");
    setSelectedGameId(gameId);
    setScreen(next);
  }, []);
  const goBack = useCallback(() => window.history.back(), []);
  const loadGamesRef = useRef(null);
  const [games, setGames] = useState([]);
  const [gamesLoading, setGamesLoading] = useState(false);
  const [recovering, setRecovering] = useState(RECOVERY_IN_URL);
  const [soundEnabled, setSoundEnabled] = useState(getSoundEnabled);
  const soundRef = useRef(soundEnabled);
  const turnStateRef = useRef(null); // { [gameId]: isMyTurn } from the previous load; null until first load

  useEffect(() => { soundRef.current = soundEnabled; }, [soundEnabled]);

  async function handleUnarchive(gameId) {
    await supabase.rpc("set_game_archived", { p_game: gameId, p_archived: false });
    loadGames(true);
  }

  function handleSoundChange(on) {
    setSoundEnabled(on);
    saveSoundEnabled(on);
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
      setSession(session);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.user) { setProfile(null); setGames([]); setScreen("list"); turnStateRef.current = null; return; }
    supabase.from("profiles").select("*").eq("id", session.user.id).single()
      .then(({ data }) => setProfile(data));
  }, [session]);

  const loadGames = useCallback(async (silent = false) => {
    if (!session?.user) return;
    if (!silent) setGamesLoading(true);
    const { data: myGameIds } = await supabase
      .from("game_players")
      .select("game_id")
      .eq("user_id", session.user.id);

    if (!myGameIds?.length) { setGames([]); turnStateRef.current = {}; setGamesLoading(false); return; }

    const ids = myGameIds.map(g => g.game_id);
    const { data } = await supabase
      .from("games")
      .select("*, game_players(*, profiles(username, avatar_url))")
      .in("id", ids)
      .order("created_at", { ascending: false });

    const gamesWithCount = data || []; // word_count is kept up to date by the database

    // Ring when a game newly becomes this user's turn (skipped on the very first load)
    const uid = session.user.id;
    const nextState = {};
    gamesWithCount.forEach((g) => { nextState[g.id] = g.status === "active" && g.current_turn_user_id === uid; });
    const prev = turnStateRef.current;
    if (prev && soundRef.current) {
      const becameMine = gamesWithCount.some(
        (g) => nextState[g.id] && (prev[g.id] === false || (prev[g.id] === undefined && g.created_by !== uid))
      );
      if (becameMine) playBell();
    }
    turnStateRef.current = nextState;

    setGames(gamesWithCount);
    setGamesLoading(false);
  }, [session]);

  useEffect(() => { if (session) loadGames(); }, [session, loadGames]);

  useEffect(() => { loadGamesRef.current = loadGames; }, [loadGames]);

  // Back/forward: show the screen that history entry belongs to
  useEffect(() => {
    window.history.replaceState({ ows: true, screen: "list" }, "");
    const onPop = (e) => {
      const st = e.state;
      setScreen(st?.ows ? st.screen : "list");
      setSelectedGameId(st?.ows ? st.gameId ?? null : null);
      loadGamesRef.current?.(true);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Notifications: re-attach this device to whoever is signed in, and open the story a tapped notification points to
  const deepLinkDone = useRef(false);
  useEffect(() => {
    if (!session || !profile) return;
    syncPushSubscription(supabase);
    if (DEEP_LINK_GAME && !deepLinkDone.current) {
      deepLinkDone.current = true;
      window.history.replaceState({ ows: true, screen: "list" }, "", window.location.pathname); // drop ?game= from the URL
      navigate("play", { gameId: DEEP_LINK_GAME });
    }
  }, [session, profile, navigate]);

  // App already open when a notification is tapped: the service worker tells us which story to show
  useEffect(() => {
    if (!session || !("serviceWorker" in navigator)) return;
    const onMsg = (e) => {
      if (e.data?.type === "OPEN_GAME" && UUID_RE.test(e.data.gameId || "")) {
        navigate("play", { gameId: e.data.gameId });
      }
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, [session, navigate]);

  // Live updates for the game list (new games, turn changes, finished stories)
  useEffect(() => {
    if (!session?.user) return;
    const channel = supabase
      .channel("my-games")
      .on("postgres_changes", { event: "*", schema: "public", table: "games" }, () => loadGames(true))
      .on("postgres_changes", { event: "*", schema: "public", table: "game_players" }, () => loadGames(true))
      .subscribe();
    const onVisible = () => { if (document.visibilityState === "visible") loadGames(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [session, loadGames]);

  if (recovering) {
    return (
      <div className="app">
        {session
          ? <ResetPasswordScreen onDone={() => setRecovering(false)} />
          : <div className="screen empty-state"><span className="spinner" /></div>}
      </div>
    );
  }

  if (!session) return <div className="app"><PwaBanners showInstall /><AuthScreen /></div>;
  if (!profile) return <div className="app"><div className="screen empty-state"><span className="spinner" /></div></div>;

  return (
    <div className="app">
      <PwaBanners showInstall={screen === "list"} aboveFab={screen === "list"} />
      {screen === "list" && (
        <GameListScreen
          userId={session.user.id}
          username={profile.username}
          avatarUrl={profile.avatar_url}
          onOpenProfile={() => navigate("profile")}
          games={games}
          loading={gamesLoading}
          onSelectGame={(g) => navigate("play", { gameId: g.id })}
          onCreateGame={() => navigate("create")}
          onRefresh={() => loadGames()}
        />
      )}
      {screen === "profile" && (
        <ProfileScreen
          userId={session.user.id}
          profile={profile}
          email={session.user.email}
          pendingEmail={session.user.new_email}
          soundEnabled={soundEnabled}
          onSoundChange={handleSoundChange}
          onBack={goBack}
          onProfileUpdated={setProfile}
          archivedCount={games.filter(g => g.status === "completed" && getMyRow(g, session.user.id)?.archived_at).length}
          onOpenArchive={() => navigate("archive")}
        />
      )}
      {screen === "archive" && (
        <ArchiveScreen
          userId={session.user.id}
          games={games}
          onBack={goBack}
          onSelectGame={(g) => navigate("play", { gameId: g.id })}
          onUnarchive={handleUnarchive}
        />
      )}
      {screen === "create" && (
        <CreateGameScreen
          userId={session.user.id}
          onBack={goBack}
          onCreated={(id) => { loadGames(true); navigate("play", { gameId: id, replace: true }); }}
        />
      )}
      {screen === "play" && selectedGameId && (
        <GamePlayScreen
          gameId={selectedGameId}
          userId={session.user.id}
          onBack={goBack}
        />
      )}
    </div>
  );
}

// Inject styles
const styleEl = document.createElement("style");
styleEl.textContent = css;
document.head.appendChild(styleEl);
