// Web Push helpers. The server side is the `send-push` Edge Function plus the push_* database functions.
// Everything here must run from a tap (iOS refuses permission prompts that aren't user-initiated).

export function pushSupported() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function isIOSDevice() {
  // iPadOS reports itself as a Mac, so also check for touch support
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function isInstalledApp() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function urlBase64ToUint8Array(b64) {
  const padded = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function saveSubscription(supabase, sub) {
  const json = sub.toJSON();
  const { error } = await supabase.rpc("save_push_subscription", {
    p_endpoint: json.endpoint,
    p_p256dh: json.keys?.p256dh,
    p_auth: json.keys?.auth,
    p_user_agent: navigator.userAgent,
  });
  if (error) throw new Error(error.message);
}

// Is this device currently subscribed (and allowed)?
export async function isPushEnabled() {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  return !!(await currentSubscription());
}

// Ask permission, subscribe, and save the subscription for the signed-in user. Call from a tap.
export async function enablePush(supabase, supabaseUrl, anonKey) {
  if (!pushSupported()) throw new Error("This browser can't receive notifications.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notifications are blocked. Allow them for this app in your phone's settings, then try again.");
  }
  const res = await fetch(`${supabaseUrl}/functions/v1/send-push`, { headers: { apikey: anonKey } });
  const { publicKey } = await res.json().catch(() => ({}));
  if (!publicKey) throw new Error("Notifications aren't switched on at the server yet.");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  }
  await saveSubscription(supabase, sub);
}

// Stop notifications on this device only.
export async function disablePush(supabase) {
  const sub = await currentSubscription();
  if (!sub) return;
  await supabase.rpc("remove_push_subscription", { p_endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

// After sign-in: if this device is already subscribed, (re)attach it to whoever is signed in now.
export async function syncPushSubscription(supabase) {
  try {
    if (!pushSupported() || Notification.permission !== "granted") return;
    const sub = await currentSubscription();
    if (sub) await saveSubscription(supabase, sub);
  } catch { /* best effort */ }
}

export async function sendTestPush(supabase) {
  const { error } = await supabase.rpc("send_test_push");
  if (error) throw new Error(error.message);
}
