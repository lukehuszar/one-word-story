# One Word Story

**Write a story with your friends, one word at a time, whenever you have a spare moment.**

A mobile-first web app (installable on your phone, with push notifications) for playing a slow, remote version of the improv game *One Word Story*.

**Live app:** https://one-word-story-roan.vercel.app

---

## The game, and why I built this

*One Word Story* is an improv game where a group of people write a story together, one word at a time. When it's done, the story is read aloud.

Writing a story with any semblance of coherence, plot and characters this way is challenging, and strangely captivating. Nobody controls where it goes, so the results are always strange and wacky and take many unexpected turns.

The game is a staple of my friend group. We have a shared Google Docs folder of more than 50 stories, some of them with multiple chapters and footnotes, and they are always a treat to come back to and read.

The goal of this project was to create a **slower-paced, remote variant** of the game: one we could play with friends over long stretches of time, during the "in-between" moments of our busy lives. Instead of sitting in a circle, each player gets a notification when it's their turn, adds a word from their phone, and gets on with their day.

It has become popular with my friends. It is no replacement for the original game, but it offers a unique variant of it, and I plan to keep adding features over time.

## Features

- **Turn-based stories** with any number of players. The creator goes first; turns rotate in order.
- **Turn timers** from 10 seconds (for a live, fast game) to 7 days (for a slow one), adjustable mid-story. Players who run out of time are skipped automatically; a story ends on its own after two full rounds with no new words.
- **Punctuation and formatting:** a word can carry punctuation (`"Heavens!"`), close the previous sentence (`. Then`), be bold or italic, or start a new line or paragraph.
- **30-second undo** for the word you just played (the "your turn" notification is held back for those 30 seconds, so an undo doesn't send a false alarm).
- **Live updates:** words appear on everyone's screen as they're played.
- **Push notifications** when it's your turn, when you're added to a story, and when a story finishes.
- **Installable app (PWA):** add it to your home screen on Android or iPhone; it opens instantly and the shell works offline.
- **Story lifecycle:** leave and rejoin, add players mid-story, end a story, reopen it within 24 hours, archive it or remove it from your own list.
- **Accounts and profiles:** usernames, profile pictures, password reset by email.

## How it works

```
 Phone / browser                     Supabase (Postgres)                  
 ┌──────────────────┐  read (RLS)   ┌─────────────────────────────┐       
 │ React app (PWA)  │ ────────────▶ │ tables: games, players,      │       
 │  + service worker│ ◀──────────── │         story_words, ...     │       
 │                  │   realtime    │                              │       
 │                  │ ── rpc() ───▶ │ game rules as SQL functions  │       
 └──────────────────┘               │  submit_word, undo, leave... │       
         ▲                          │ pg_cron: skip expired turns  │       
         │ Web Push                 │ triggers ──▶ send-push (Edge │       
         └───────────────────────── │              Function, Deno) │       
                                    └─────────────────────────────┘       
```

The main design decision was to put **all of the game's rules in the database** rather than in the browser.

- **The browser can only read.** Row Level Security policies let a signed-in user see only the stories they belong to, and give no one permission to insert, update or delete game data directly. That closes off the obvious cheats (playing out of turn, editing someone else's word, skipping another player).
- **Every action is a Postgres function** (`submit_word`, `undo_last_word`, `leave_game`, `reopen_story`, ...). Each one checks who is calling, validates the input, and locks the game row (`SELECT ... FOR UPDATE`) so two players acting at the same moment can't corrupt the turn order. The word-format rules are enforced twice: in JavaScript for instant feedback, and in SQL as the source of truth.
- **Timers run on the server.** A `pg_cron` job checks every minute for expired turns, so a story keeps moving even when nobody has the app open.
- **Notifications are event-driven.** Database triggers on turn changes call a small Supabase Edge Function over HTTP, which sends Web Push messages to each of the player's devices.

The full schema, with the tables, security policies, functions, triggers and scheduled jobs, is in [`supabase/schema.sql`](supabase/schema.sql).

## Tech stack

| Layer | Tools |
|---|---|
| Front end | React 19, Vite, plain JavaScript, self-hosted fonts |
| Installable app | `vite-plugin-pwa` with a custom Workbox service worker (caching + push) |
| Back end | Supabase: Postgres 17, Auth, Realtime, Storage (avatars) |
| Server logic | PL/pgSQL functions, Row Level Security, `pg_cron`, `pg_net`, Vault |
| Notifications | Web Push (VAPID) from a Supabase Edge Function (Deno / TypeScript) |
| Hosting | Vercel (deploys automatically from `main`) |

## Project structure

```
src/
  OneWordStory.jsx      the app: screens, components and styles
  push.js               subscribing a device to push notifications
  sw.js                 service worker: offline shell, showing notifications
  main.jsx              entry point
public/                 app icons
supabase/
  schema.sql            full database schema (start here)
  migrations/           later changes, as applied to the live database
  functions/send-push/  Edge Function that delivers push notifications
vite.config.js          build and PWA manifest settings
```

## Running it locally

You need Node.js 20.19 or later.

```bash
git clone https://github.com/lukehuszar/one-word-story.git
cd one-word-story
npm install
npm run dev
```

By default the app connects to the live Supabase project (its URL and publishable key are public by design; Row Level Security is what protects the data). To run against your own backend, create a Supabase project, run `supabase/schema.sql` in its SQL editor, and copy `.env.example` to `.env` with your project's values. Push notifications additionally need the `send-push` function deployed and VAPID keys set as function secrets.

## What's next

I plan to keep adding features over time. Currently on the list:

- A "your turn is ending soon" reminder
- Testing and polishing the iPhone home-screen app
- A custom domain

## How this was built

Most of my training is in data science, not software development. I built this project working closely with Claude (Anthropic's AI assistant), which was instrumental in putting it together: I set the direction, made the design decisions and tested everything with real players, while Claude helped design and write much of the code. Along the way I learned a lot about SQL, database security, and how a modern web app fits together, from service workers to deployment.
