// send-push: called by database triggers (via pg_net) and by the app's "send test" button.
// POST  {type: 'turn'|'added'|'finished'|'test', ...}  with header x-webhook-secret  -> sends Web Push messages
// GET   -> returns the public VAPID key (public by design) so the app never needs it baked in
// Secrets (set in the Supabase dashboard): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const APP_URL = "https://one-word-story-roan.vercel.app";
const HOLD_MS = 30_000; // "your turn" waits this long so the previous player can still Undo

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-webhook-secret, authorization, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

let cachedSecret: string | null = null;
async function expectedSecret(): Promise<string | null> {
  if (cachedSecret) return cachedSecret;
  const { data, error } = await db.rpc("push_webhook_secret");
  if (error || !data) return null;
  cachedSecret = data as string;
  return cachedSecret;
}

function sameString(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// A secret pasted into a dashboard often picks up stray characters (spaces, a line break, quotes, "=" padding).
// web-push wants plain URL-safe base64, so tidy it rather than fail.
function vapidKey(name: string): string | null {
  const raw = Deno.env.get(name);
  if (!raw) return null;
  const k = raw.replace(/\s+/g, "").replace(/^["']+|["']+$/g, "").replace(/=+$/, "");
  return k || null;
}

type Payload = { title: string; body: string; url: string; tag: string };

async function sendTo(userIds: string[], payload: Payload) {
  if (!userIds.length) return;
  const pub = vapidKey("VAPID_PUBLIC_KEY");
  const priv = vapidKey("VAPID_PRIVATE_KEY");
  if (!pub || !priv) { console.error("VAPID keys are not set"); return; }
  webpush.setVapidDetails(APP_URL, pub, priv);

  const { data: subs } = await db.from("push_subscriptions")
    .select("id, endpoint, p256dh, auth").in("user_id", userIds);
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 86400, urgency: "high" },
      );
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from("push_subscriptions").delete().eq("id", s.id);
      else console.error("push failed", code, (e as Error).message);
    }
  }));
}

async function lastWords(gameId: string): Promise<string> {
  const { data } = await db.from("story_words").select("word_text")
    .eq("game_id", gameId).order("word_order", { ascending: false }).limit(8);
  if (!data?.length) return "Be the first to write a word.";
  return "…" + data.reverse().map((w) => w.word_text).join(" ");
}

async function handle(ev: Record<string, string>) {
  const gameUrl = (id: string) => `/?game=${id}`;

  if (ev.type === "test") {
    await sendTo([ev.user_id], {
      title: "Notifications are working",
      body: "You'll get a message here when it's your turn.",
      url: "/", tag: "test",
    });
    return;
  }

  const { data: game } = await db.from("games")
    .select("id, name, status, current_turn_user_id, turn_deadline, word_count")
    .eq("id", ev.game_id).maybeSingle();
  if (!game) return;

  if (ev.type === "turn") {
    await new Promise((r) => setTimeout(r, HOLD_MS));
    const { data: g } = await db.from("games")
      .select("status, current_turn_user_id, turn_deadline").eq("id", ev.game_id).maybeSingle();
    // Still this person's turn, same turn (an undo-and-resubmit would have a new deadline)?
    if (!g || g.status !== "active" || g.current_turn_user_id !== ev.user_id) return;
    if (new Date(g.turn_deadline).getTime() !== new Date(ev.deadline).getTime()) return;
    const { data: me } = await db.from("game_players").select("left_at")
      .eq("game_id", ev.game_id).eq("user_id", ev.user_id).maybeSingle();
    if (!me || me.left_at) return;
    await sendTo([ev.user_id], {
      title: `Your turn in “${game.name}”`,
      body: await lastWords(ev.game_id),
      url: gameUrl(ev.game_id), tag: `game-${ev.game_id}`,
    });
    return;
  }

  if (ev.type === "added") {
    let who = "Someone";
    if (ev.by) {
      const { data: p } = await db.from("profiles").select("username").eq("id", ev.by).maybeSingle();
      if (p?.username) who = p.username;
    }
    const firstUp = game.current_turn_user_id === ev.user_id;
    await sendTo([ev.user_id], {
      title: `${who} added you to a story`,
      body: `“${game.name}”${firstUp ? " — you're up first" : ""}`,
      url: gameUrl(ev.game_id), tag: `game-${ev.game_id}`,
    });
    return;
  }

  if (ev.type === "finished") {
    const { data: players } = await db.from("game_players").select("user_id")
      .eq("game_id", ev.game_id).is("left_at", null);
    await sendTo((players ?? []).map((p) => p.user_id), {
      title: `“${game.name}” is finished`,
      body: `Read the finished story (${game.word_count} words).`,
      url: gameUrl(ev.game_id), tag: `game-${ev.game_id}`,
    });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  if (req.method === "GET") {
    return new Response(JSON.stringify({ publicKey: vapidKey("VAPID_PUBLIC_KEY") }), {
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
    });
  }

  const sent = req.headers.get("x-webhook-secret") ?? "";
  const expected = await expectedSecret();
  if (!expected || !sameString(sent, expected)) return new Response("Forbidden", { status: 403, headers: cors });

  let ev: Record<string, string>;
  try { ev = await req.json(); } catch { return new Response("Bad request", { status: 400, headers: cors }); }

  // Answer right away; do the (possibly 30-second) work in the background
  EdgeRuntime.waitUntil(handle(ev).catch((e) => console.error("handle failed", e)));
  return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { ...cors, "Content-Type": "application/json" } });
});
