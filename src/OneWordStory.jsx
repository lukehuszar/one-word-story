import { useState, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Replace these with your Supabase project URL and anon key
const SUPABASE_URL = "https://wzeenraywlbxhecdnrfv.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_7LjFzl3p3NkkEoCv7AL1qQ_eA1zhltb";

// Read the URL hash before Supabase consumes it, so we know the user arrived via a reset link
const RECOVERY_IN_URL =
  typeof window !== "undefined" && window.location.hash.includes("type=recovery");

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function validateWord(input) {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 50) return false;
  const pattern = /^[\p{L}\p{N}_'’-]+[.,!?;:]*$/u;
  return pattern.test(trimmed);
}

function timeLeft(deadline) {
  if (!deadline) return null;
  const diff = new Date(deadline) - new Date();
  if (diff <= 0) return "Expired";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 24) return `${Math.floor(h / 24)}d left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

function storyText(words) {
  return words.map((w) => w.word_text).join(" ");
}

// ─── GAME LOGIC ──────────────────────────────────────────────────────────────
async function checkAndAdvanceTurn(game) {
  if (!game || game.status !== "active") return;
  if (!game.turn_deadline) return;
  if (new Date() <= new Date(game.turn_deadline)) return;

  const players = [...game.game_players].sort(
    (a, b) => a.player_order - b.player_order
  );
  const currentIndex = players.findIndex(
    (p) => p.user_id === game.current_turn_user_id
  );
  const nextIndex = (currentIndex + 1) % players.length;
  const nextPlayer = players[nextIndex];
  const newDeadline = new Date();
  newDeadline.setHours(newDeadline.getHours() + game.turn_time_limit_hours);

  await supabase
    .from("games")
    .update({
      current_turn_user_id: nextPlayer.user_id,
      turn_deadline: newDeadline.toISOString(),
    })
    .eq("id", game.id);
}

async function submitWord(game, word, userId) {
  if (!validateWord(word)) throw new Error("Invalid word: one word only, optional punctuation at the end.");

  await checkAndAdvanceTurn(game);

  const { data: freshGame } = await supabase
    .from("games")
    .select("*, game_players(*)")
    .eq("id", game.id)
    .single();

  if (freshGame.current_turn_user_id !== userId)
    throw new Error("Not your turn.");

  const { count } = await supabase
    .from("story_words")
    .select("*", { count: "exact", head: true })
    .eq("game_id", game.id);

  await supabase.from("story_words").insert({
    game_id: game.id,
    user_id: userId,
    word_text: word.trim(),
    word_order: count || 0,
  });

  const players = [...freshGame.game_players].sort(
    (a, b) => a.player_order - b.player_order
  );
  const currentIndex = players.findIndex((p) => p.user_id === userId);
  const nextIndex = (currentIndex + 1) % players.length;
  const nextPlayer = players[nextIndex];
  const newDeadline = new Date();
  newDeadline.setHours(newDeadline.getHours() + freshGame.turn_time_limit_hours);

  await supabase
    .from("games")
    .update({
      current_turn_user_id: nextPlayer.user_id,
      turn_deadline: newDeadline.toISOString(),
    })
    .eq("id", game.id);
}

// ─── STYLES ──────────────────────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;1,400&family=DM+Mono:wght@400;500&display=swap');

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
    -webkit-font-smoothing: antialiased;
  }

  .app {
    max-width: 480px;
    margin: 0 auto;
    min-height: 100vh;
    padding: 0 0 env(safe-area-inset-bottom, 0);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px 20px 12px;
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
    font-style: italic;
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
    bottom: 24px;
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
    bottom: 24px;
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
`;

// ─── COMPONENTS ──────────────────────────────────────────────────────────────

function Toast({ msg }) {
  if (!msg) return null;
  return <div className="toast">{msg}</div>;
}

function AuthScreen({ onAuth }) {
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

function GameListScreen({ userId, username, onSelectGame, onCreateGame, onRefresh, games, loading }) {
  const myTurnGames = games.filter(g => g.current_turn_user_id === userId && g.status === "active");
  const waitingGames = games.filter(g => g.current_turn_user_id !== userId && g.status === "active");
  const completedGames = games.filter(g => g.status === "completed");

  function GameCard({ game }) {
    const isMyTurn = game.current_turn_user_id === userId;
    const tl = timeLeft(game.turn_deadline);
    const currentPlayer = game.game_players?.find(p => p.user_id === game.current_turn_user_id);
    const currentName = currentPlayer?.profiles?.username || "someone";

    return (
      <div className={`game-card ${isMyTurn ? "your-turn" : ""}`} onClick={() => onSelectGame(game)}>
        {isMyTurn && <div className="your-turn-badge">✦ Your turn</div>}
        <div className="game-card-title">{game.name}</div>
        <div className="game-card-meta">
          {game.status === "completed"
            ? `${game.word_count || 0} words`
            : isMyTurn
              ? tl || "Time expired"
              : `Waiting for ${currentName} · ${tl || ""}`}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="header">
        <div>
          <div className="logo-mark">one word story</div>
          <div className="header-title">@{username}</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>

      <div className="screen">
        {loading ? (
          <div className="empty-state"><span className="spinner" /></div>
        ) : games.length === 0 ? (
          <div className="empty-state">No games yet.<br />Start one with the + button.</div>
        ) : (
          <>
            {myTurnGames.length > 0 && (
              <>
                <div className="section-label">Your turn</div>
                {myTurnGames.map(g => <GameCard key={g.id} game={g} />)}
              </>
            )}
            {waitingGames.length > 0 && (
              <>
                <div className="section-label">Waiting</div>
                {waitingGames.map(g => <GameCard key={g.id} game={g} />)}
              </>
            )}
            {completedGames.length > 0 && (
              <>
                <div className="section-label">Completed</div>
                {completedGames.map(g => <GameCard key={g.id} game={g} />)}
              </>
            )}
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

function CreateGameScreen({ userId, onBack, onCreated, toast }) {
  const [name, setName] = useState("");
  const [timeLimit, setTimeLimit] = useState(24);
  const [playerInput, setPlayerInput] = useState("");
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function addPlayer() {
    const un = playerInput.trim().toLowerCase();
    if (!un) return;
    if (players.length >= 5) { setError("Max 6 players"); return; }
    if (players.find(p => p.username === un)) { setError("Already added"); return; }
    const { data } = await supabase.from("profiles").select("id, username").eq("username", un).single();
    if (!data) { setError(`User "${un}" not found`); return; }
    setPlayers(p => [...p, data]);
    setPlayerInput("");
    setError("");
  }

  async function createGame() {
    if (!name.trim()) { setError("Enter a game name"); return; }
    setLoading(true);
    setError("");
    try {
      const allPlayers = [{ id: userId }, ...players];

      const deadline = new Date();
      deadline.setHours(deadline.getHours() + timeLimit);

      const { data: game, error: ge } = await supabase.from("games").insert({
        name: name.trim(),
        created_by: userId,
        turn_time_limit_hours: timeLimit,
        current_turn_user_id: userId,
        turn_deadline: deadline.toISOString(),
        status: "active",
      }).select().single();
      if (ge) throw ge;

      const playerRows = allPlayers.map((p, i) => ({
        game_id: game.id,
        user_id: p.id,
        player_order: i,
      }));
      const { error: ple } = await supabase.from("game_players").insert(playerRows);
      if (ple) throw ple;

      onCreated(game.id);
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
          <select value={timeLimit} onChange={e => setTimeLimit(Number(e.target.value))}>
            <option value={1}>1 hour</option>
            <option value={6}>6 hours</option>
            <option value={12}>12 hours</option>
            <option value={24}>24 hours</option>
            <option value={48}>48 hours</option>
          </select>
        </div>

        <div className="section-label">Players</div>
        <div className="player-row">
          <div className="player-avatar">you</div>
          <span className="player-name">You (creator)</span>
        </div>
        {players.map((p, i) => (
          <div className="player-row" key={p.id}>
            <div className="player-avatar">{p.username[0].toUpperCase()}</div>
            <span className="player-name">@{p.username}</span>
            <button className="remove-btn" onClick={() => setPlayers(ps => ps.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}

        <div className="word-input-row" style={{ marginBottom: 20 }}>
          <div className="field">
            <input
              value={playerInput}
              onChange={e => setPlayerInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addPlayer()}
              placeholder="add by username…"
            />
          </div>
          <button className="btn btn-ghost btn-sm" onClick={addPlayer}>Add</button>
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
  const [, setNow] = useState(Date.now()); // forces re-render so the countdown updates

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2000);
  };

  // advance=true also skips expired turns; live updates pass false (just re-read)
  const loadGame = useCallback(async (advance = true) => {
    const { data: g } = await supabase
      .from("games")
      .select("*, game_players(*, profiles(username))")
      .eq("id", gameId)
      .single();

    if (g) {
      if (advance && g.status === "active" && g.turn_deadline && new Date() > new Date(g.turn_deadline)) {
        await checkAndAdvanceTurn(g);
        const { data: gFresh } = await supabase
          .from("games")
          .select("*, game_players(*, profiles(username))")
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
      await submitWord(game, wordInput.trim(), userId);
      setWordInput("");
      showToast("Word added!");
      await loadGame();
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleEndGame() {
    if (!confirm("End this story?")) return;
    await supabase.from("games").update({ status: "completed" }).eq("id", gameId);
    showToast("Story completed!");
    await loadGame();
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

  const isMyTurn = game.current_turn_user_id === userId && game.status === "active";
  const currentPlayer = game.game_players?.find(p => p.user_id === game.current_turn_user_id);
  const currentPlayerName = currentPlayer?.profiles?.username || "someone";
  const tl = timeLeft(game.turn_deadline);
  const playerOrder = [...(game.game_players || [])].sort((a, b) => a.player_order - b.player_order);

  return (
    <>
      <div className="header">
        <button className="back-btn" onClick={onBack}>← Games</button>
        <div className="header-title" style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{game.name}</div>
        <button className="btn btn-ghost btn-sm" onClick={copyStory}>Copy</button>
      </div>

      <div className="screen">
        {game.status === "completed" && (
          <div className="completed-banner">This story is complete. {words.length} words written.</div>
        )}

        <div className="story-box">
          {words.length === 0
            ? <span className="story-empty">The story begins…</span>
            : words.map((w, i) => (
              <span key={w.id} className={`word-chip ${w.user_id === userId ? "mine" : ""}`}>
                {i > 0 ? " " : ""}{w.word_text}
              </span>
            ))}
        </div>

        {game.status === "active" && (
          <>
            <div className={`turn-status ${isMyTurn ? "my-turn" : "waiting"}`}>
              <div className="turn-status-name">
                {isMyTurn ? "Your turn" : `Waiting for @${currentPlayerName}`}
              </div>
              {tl && <div className="turn-status-time">{tl}</div>}
            </div>

            {error && <div className="error-box">{error}</div>}

            {isMyTurn && (
              <div className="word-input-row">
                <div className="field">
                  <input
                    value={wordInput}
                    onChange={e => setWordInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleSubmit()}
                    placeholder="one word…"
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

            <div className="refresh-row">
              <button className="refresh-btn" onClick={() => loadGame(true)}>↻ Refresh</button>
            </div>

            <div className="end-game-row">
              <button className="btn-danger" onClick={handleEndGame}>End story</button>
            </div>
          </>
        )}

        <div className="section-label" style={{ marginTop: 24 }}>Players</div>
        {playerOrder?.map(p => (
          <div className="player-row" key={p.user_id}>
            <div className="player-avatar">
              {(p.profiles?.username || "?")[0].toUpperCase()}
            </div>
            <span className="player-name">@{p.profiles?.username}</span>
            {p.user_id === game.current_turn_user_id && game.status === "active" && (
              <span style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: "var(--accent)", background: "color-mix(in srgb, var(--accent) 10%, transparent)", padding: "2px 8px", borderRadius: 99 }}>
                current
              </span>
            )}
          </div>
        ))}
      </div>

      <Toast msg={toast} />
    </>
  );
}

// ─── APP ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [screen, setScreen] = useState("list");
  const [selectedGameId, setSelectedGameId] = useState(null);
  const [games, setGames] = useState([]);
  const [gamesLoading, setGamesLoading] = useState(false);
  const [recovering, setRecovering] = useState(RECOVERY_IN_URL);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
      setSession(session);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.user) { setProfile(null); setGames([]); setScreen("list"); return; }
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

    if (!myGameIds?.length) { setGames([]); setGamesLoading(false); return; }

    const ids = myGameIds.map(g => g.game_id);
    const { data } = await supabase
      .from("games")
      .select("*, game_players(*, profiles(username))")
      .in("id", ids)
      .order("created_at", { ascending: false });

    const gamesWithCount = await Promise.all(
      (data || []).map(async (g) => {
        const { count } = await supabase
          .from("story_words")
          .select("*", { count: "exact", head: true })
          .eq("game_id", g.id);
        return { ...g, word_count: count };
      })
    );
    setGames(gamesWithCount);
    setGamesLoading(false);
  }, [session]);

  useEffect(() => { if (session) loadGames(); }, [session, loadGames]);

  // Live updates for the game list (new games, turn changes, finished stories)
  useEffect(() => {
    if (!session?.user) return;
    const channel = supabase
      .channel("my-games")
      .on("postgres_changes", { event: "*", schema: "public", table: "games" }, () => loadGames(true))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "game_players" }, () => loadGames(true))
      .subscribe();
    const onVisible = () => { if (document.visibilityState === "visible") loadGames(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [session, loadGames]);

  if (SUPABASE_URL === "https://YOUR_PROJECT.supabase.co") {
    return (
      <div style={{ padding: 32, fontFamily: "'DM Mono', monospace", fontSize: 13, lineHeight: 1.8, color: "var(--color-text-primary)" }}>
        <div style={{ fontSize: 22, fontFamily: "Georgia, serif", fontWeight: 600, marginBottom: 16 }}>Setup required</div>
        <p style={{ marginBottom: 12 }}>Open <code>OneWordStory.jsx</code> and replace the two constants at the top:</p>
        <pre style={{ background: "var(--color-background-secondary)", padding: 16, borderRadius: 8, fontSize: 12, overflowX: "auto" }}>
{`const SUPABASE_URL = "https://YOUR_PROJECT.supabase.co";
const SUPABASE_ANON_KEY = "YOUR_ANON_KEY";`}
        </pre>
        <p style={{ marginTop: 12 }}>Find these in your Supabase dashboard under <strong>Project Settings → API</strong>.</p>
        <p style={{ marginTop: 12 }}>Also run the SQL schema from the implementation plan in your Supabase SQL Editor first.</p>
      </div>
    );
  }

  if (recovering) {
    return (
      <div className="app">
        {session
          ? <ResetPasswordScreen onDone={() => setRecovering(false)} />
          : <div className="screen empty-state"><span className="spinner" /></div>}
      </div>
    );
  }

  if (!session) return <div className="app"><AuthScreen onAuth={setSession} /></div>;
  if (!profile) return <div className="app"><div className="screen empty-state"><span className="spinner" /></div></div>;

  return (
    <div className="app">
      {screen === "list" && (
        <GameListScreen
          userId={session.user.id}
          username={profile.username}
          games={games}
          loading={gamesLoading}
          onSelectGame={(g) => { setSelectedGameId(g.id); setScreen("play"); }}
          onCreateGame={() => setScreen("create")}
          onRefresh={() => loadGames()}
        />
      )}
      {screen === "create" && (
        <CreateGameScreen
          userId={session.user.id}
          onBack={() => setScreen("list")}
          onCreated={(id) => { setSelectedGameId(id); loadGames(true); setScreen("play"); }}
        />
      )}
      {screen === "play" && selectedGameId && (
        <GamePlayScreen
          gameId={selectedGameId}
          userId={session.user.id}
          onBack={() => { setScreen("list"); loadGames(true); }}
        />
      )}
    </div>
  );
}

// Inject styles
const styleEl = document.createElement("style");
styleEl.textContent = css;
document.head.appendChild(styleEl);
