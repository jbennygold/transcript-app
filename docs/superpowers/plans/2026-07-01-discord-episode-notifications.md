# Discord Episode-Lifecycle Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post to the dunepod Discord `#pod-data-central` channel when an episode needs speaker mapping (freshly transcribed) and when an episode is ingested into the search corpus.

**Architecture:** A single Discord incoming webhook receives fire-and-forget POSTs from transcript-app's GitHub Actions. One new script, `scripts/notify-discord.ts`, builds the message payloads (pure functions) and posts them; it is invoked as a non-fatal step in `new-episodes.yml` (Event 1, batched) and `ingest-episode.yml` (Event 2, single). Episode titles are resolved from `data/episode-metadata.json`. The `transcript-bot` repo is untouched — "the bot" is only the webhook's display name/avatar.

**Tech Stack:** TypeScript run via `tsx` (Node 25), built-in `node:test` + `node:assert/strict` for tests, native `fetch`, no new npm dependencies.

## Global Constraints

- No new npm dependencies — use native `fetch` and `node:*` built-ins only.
- Scripts run via `node --import tsx` (repo convention); ESM modules.
- The notifier must **never fail CI**: on missing webhook URL, missing input, or a failed/non-2xx/429 POST, log a warning and exit 0 (no `process.exit(1)`, no thrown error escaping `main`).
- Webhook URL is read from env `DISCORD_PDC_WEBHOOK_URL` (a GitHub Actions secret). Base URL from env `NEXT_PUBLIC_BASE_URL`, default `https://search.escapehatchpod.com` (strip trailing slashes).
- Event 1 keys off the **per-run** freshly-transcribed set (`transcribed-episodes.txt`), never a global backlog, so each episode is announced exactly once.
- Colors: amber `0xF59E0B` (needs mapping), green `0x22C55E` (ingested). Max 10 embeds per Discord message; overflow beyond 10 collapses into a content summary line.
- Metadata source: `data/episode-metadata.json` — a plain array of records with numeric `episode`, string `film` (e.g. `"The Thing (1982)"`), string `reviewer`. Missing episode → fall back to `Episode N` with null film/reviewer.

---

## File Structure

- `scripts/notify-discord.ts` (new) — the notifier. Exports pure builders + `resolveEpisodes` + `postToDiscord`; a guarded `main()` handles CLI/env when run directly.
- `scripts/notify-discord.test.ts` (new) — `node:test` unit tests for the pure builders and metadata resolution.
- `.github/workflows/new-episodes.yml` (modify) — add one non-fatal notify step (Event 1).
- `.github/workflows/ingest-episode.yml` (modify) — add one non-fatal notify step (Event 2).
- `package.json` (modify) — add `test:notify` script.

---

## Task 1: Message builders + types (pure functions)

**Files:**
- Create: `scripts/notify-discord.ts`
- Test: `scripts/notify-discord.test.ts`
- Modify: `package.json` (add `test:notify` script)

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `interface EpisodeInfo { episode: number; film: string | null; reviewer: string | null }`
  - `interface DiscordEmbed { title: string; url?: string; description?: string; color: number; fields?: { name: string; value: string; inline?: boolean }[] }`
  - `interface WebhookPayload { content?: string; embeds: DiscordEmbed[] }`
  - `const AMBER = 0xf59e0b`, `const GREEN = 0x22c55e`
  - `buildNeedsMappingMessage(episodes: EpisodeInfo[], baseUrl: string): WebhookPayload`
  - `buildIngestedMessage(episode: EpisodeInfo, baseUrl: string): WebhookPayload`

- [ ] **Step 1: Write the failing tests**

Create `scripts/notify-discord.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNeedsMappingMessage,
  buildIngestedMessage,
  AMBER,
  GREEN,
} from './notify-discord.ts';

test('needs-mapping: single episode → amber embed with review link + reviewer field', () => {
  const payload = buildNeedsMappingMessage(
    [{ episode: 312, film: 'The Thing (1982)', reviewer: 'Jason' }],
    'https://x.test'
  );
  assert.equal(payload.content, '🎙️ 1 new episode needs speaker mapping');
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].title, 'Ep 312 · The Thing (1982)');
  assert.equal(payload.embeds[0].url, 'https://x.test/review/312');
  assert.equal(payload.embeds[0].color, AMBER);
  assert.deepEqual(payload.embeds[0].fields, [
    { name: 'Reviewer', value: 'Jason', inline: true },
  ]);
});

test('needs-mapping: plural content for multiple episodes', () => {
  const payload = buildNeedsMappingMessage(
    [
      { episode: 312, film: 'The Thing (1982)', reviewer: 'Jason' },
      { episode: 313, film: 'Alien (1979)', reviewer: 'Haitch' },
    ],
    'https://x.test'
  );
  assert.equal(payload.content, '🎙️ 2 new episodes need speaker mapping');
  assert.equal(payload.embeds.length, 2);
});

test('needs-mapping: missing film → "Episode N" title, reviewer field omitted', () => {
  const payload = buildNeedsMappingMessage(
    [{ episode: 999, film: null, reviewer: null }],
    'https://x.test'
  );
  assert.equal(payload.embeds[0].title, 'Episode 999');
  assert.equal(payload.embeds[0].fields, undefined);
});

test('needs-mapping: >10 episodes → 10 embeds + overflow summary line', () => {
  const episodes = Array.from({ length: 13 }, (_, i) => ({
    episode: 300 + i,
    film: `Film ${i}`,
    reviewer: null,
  }));
  const payload = buildNeedsMappingMessage(episodes, 'https://x.test');
  assert.equal(payload.embeds.length, 10);
  assert.match(payload.content ?? '', /\+3 more: 310, 311, 312/);
});

test('ingested: single green embed with searchable copy + homepage link', () => {
  const payload = buildIngestedMessage(
    { episode: 312, film: 'The Thing (1982)', reviewer: 'Jason' },
    'https://x.test'
  );
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].title, '✅ Ingested into search corpus');
  assert.equal(payload.embeds[0].color, GREEN);
  assert.match(payload.embeds[0].description ?? '', /Ep 312 · The Thing \(1982\)/);
  assert.match(payload.embeds[0].description ?? '', /now searchable/);
  assert.equal(payload.embeds[0].url, 'https://x.test');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test scripts/notify-discord.test.ts`
Expected: FAIL — cannot resolve module `./notify-discord.ts` (file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/notify-discord.ts`:

```ts
// Posts episode-lifecycle notifications to the #pod-data-central Discord
// channel via an incoming webhook. Invoked from GitHub Actions. Never fails CI.

export interface EpisodeInfo {
  episode: number;
  film: string | null;
  reviewer: string | null;
}

export interface DiscordEmbed {
  title: string;
  url?: string;
  description?: string;
  color: number;
  fields?: { name: string; value: string; inline?: boolean }[];
}

export interface WebhookPayload {
  content?: string;
  embeds: DiscordEmbed[];
}

export const AMBER = 0xf59e0b;
export const GREEN = 0x22c55e;
const MAX_EMBEDS = 10;

function episodeLabel(e: EpisodeInfo): string {
  return e.film ? `Ep ${e.episode} · ${e.film}` : `Episode ${e.episode}`;
}

export function buildNeedsMappingMessage(
  episodes: EpisodeInfo[],
  baseUrl: string
): WebhookPayload {
  const count = episodes.length;
  const shown = episodes.slice(0, MAX_EMBEDS);
  const overflow = episodes.slice(MAX_EMBEDS);

  let content =
    count === 1
      ? '🎙️ 1 new episode needs speaker mapping'
      : `🎙️ ${count} new episodes need speaker mapping`;
  if (overflow.length > 0) {
    content += `\n+${overflow.length} more: ${overflow.map((e) => e.episode).join(', ')}`;
  }

  const embeds: DiscordEmbed[] = shown.map((e) => {
    const embed: DiscordEmbed = {
      title: episodeLabel(e),
      url: `${baseUrl}/review/${e.episode}`,
      color: AMBER,
    };
    if (e.reviewer) {
      embed.fields = [{ name: 'Reviewer', value: e.reviewer, inline: true }];
    }
    return embed;
  });

  return { content, embeds };
}

export function buildIngestedMessage(
  episode: EpisodeInfo,
  baseUrl: string
): WebhookPayload {
  return {
    embeds: [
      {
        title: '✅ Ingested into search corpus',
        description: `${episodeLabel(episode)} — speaker mapping + cleanup complete, now searchable`,
        url: baseUrl,
        color: GREEN,
      },
    ],
  };
}
```

- [ ] **Step 4: Add the `test:notify` npm script**

In `package.json`, add to `"scripts"` (after the existing `"check-new-episodes"` entry):

```json
    "test:notify": "node --import tsx --test scripts/notify-discord.test.ts"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:notify`
Expected: PASS — all 5 tests green.

- [ ] **Step 6: Commit**

```bash
git add scripts/notify-discord.ts scripts/notify-discord.test.ts package.json
git commit -m "feat(notify): Discord message builders for episode notifications"
```

---

## Task 2: Resolve episodes from metadata

**Files:**
- Modify: `scripts/notify-discord.ts`
- Test: `scripts/notify-discord.test.ts`

**Interfaces:**
- Consumes: `EpisodeInfo` (Task 1).
- Produces: `resolveEpisodes(numbers: number[], metadataPath: string): EpisodeInfo[]` — reads the JSON array at `metadataPath`, maps each requested episode number to `{ episode, film, reviewer }`, using `null` for film/reviewer when the episode is absent or the file is unreadable.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/notify-discord.test.ts`:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEpisodes } from './notify-discord.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const METADATA = path.resolve(__dirname, '..', 'data', 'episode-metadata.json');

test('resolveEpisodes: resolves film + reviewer from real metadata (ep 293)', () => {
  const [info] = resolveEpisodes([293], METADATA);
  assert.equal(info.episode, 293);
  assert.equal(info.film, 'Panic Room (2002)');
  assert.equal(info.reviewer, 'birria');
});

test('resolveEpisodes: unknown episode → null film/reviewer', () => {
  const [info] = resolveEpisodes([999999], METADATA);
  assert.deepEqual(info, { episode: 999999, film: null, reviewer: null });
});

test('resolveEpisodes: unreadable metadata path → null fields, no throw', () => {
  const [info] = resolveEpisodes([293], '/no/such/file.json');
  assert.deepEqual(info, { episode: 293, film: null, reviewer: null });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:notify`
Expected: FAIL — `resolveEpisodes` is not exported / not a function.

- [ ] **Step 3: Write minimal implementation**

Add to the top of `scripts/notify-discord.ts` (imports), below the file-header comment:

```ts
import fs from 'node:fs';
```

Add this function after `buildIngestedMessage`:

```ts
export function resolveEpisodes(
  numbers: number[],
  metadataPath: string
): EpisodeInfo[] {
  let records: unknown[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (Array.isArray(parsed)) records = parsed;
  } catch {
    records = [];
  }

  const byNumber = new Map<number, { film?: unknown; reviewer?: unknown }>();
  for (const r of records) {
    if (r && typeof r === 'object' && typeof (r as any).episode === 'number') {
      byNumber.set((r as any).episode, r as any);
    }
  }

  return numbers.map((n) => {
    const r = byNumber.get(n);
    return {
      episode: n,
      film: r && typeof r.film === 'string' ? r.film : null,
      reviewer: r && typeof r.reviewer === 'string' ? r.reviewer : null,
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:notify`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/notify-discord.ts scripts/notify-discord.test.ts
git commit -m "feat(notify): resolve episode film/reviewer from metadata"
```

---

## Task 3: Webhook POST + CLI entrypoint

**Files:**
- Modify: `scripts/notify-discord.ts`

**Interfaces:**
- Consumes: `buildNeedsMappingMessage`, `buildIngestedMessage`, `resolveEpisodes`, `WebhookPayload` (Tasks 1–2).
- Produces:
  - `postToDiscord(webhookUrl: string, payload: WebhookPayload): Promise<void>` — POSTs JSON; throws on non-2xx.
  - A guarded `main()` that runs only when the file is executed directly (`node --import tsx scripts/notify-discord.ts ...`). CLI: `--event=needs-mapping [--episodes=312,313]` or `--event=ingested --episode=N`.

- [ ] **Step 1: Add POST helper, input readers, and guarded main**

Add `path`/`url` imports at the top of `scripts/notify-discord.ts` (alongside the `fs` import from Task 2):

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
```

Append to the end of `scripts/notify-discord.ts`:

```ts
export async function postToDiscord(
  webhookUrl: string,
  payload: WebhookPayload
): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook returned ${res.status}: ${await res.text()}`);
  }
}

function readTranscribedEpisodes(filePath: string): number[] {
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n));
  } catch {
    return [];
  }
}

function getArg(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const webhookUrl = process.env.DISCORD_PDC_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[notify-discord] DISCORD_PDC_WEBHOOK_URL not set — skipping.');
    return;
  }

  const baseUrl = (
    process.env.NEXT_PUBLIC_BASE_URL || 'https://search.escapehatchpod.com'
  ).replace(/\/+$/, '');
  const metadataPath = path.resolve(__dirname, '..', 'data', 'episode-metadata.json');
  const event = getArg(args, 'event');

  let payload: WebhookPayload;

  if (event === 'needs-mapping') {
    const explicit = getArg(args, 'episodes');
    const numbers = explicit
      ? explicit.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n))
      : readTranscribedEpisodes(path.resolve(__dirname, '..', 'transcribed-episodes.txt'));
    if (numbers.length === 0) {
      console.warn('[notify-discord] No transcribed episodes to announce — skipping.');
      return;
    }
    payload = buildNeedsMappingMessage(resolveEpisodes(numbers, metadataPath), baseUrl);
  } else if (event === 'ingested') {
    const epArg = getArg(args, 'episode');
    const episode = Number(epArg);
    if (!Number.isInteger(episode)) {
      console.warn(`[notify-discord] --episode must be a number (got "${epArg}") — skipping.`);
      return;
    }
    payload = buildIngestedMessage(resolveEpisodes([episode], metadataPath)[0], baseUrl);
  } else {
    console.warn(`[notify-discord] Unknown --event "${event}" — expected needs-mapping or ingested.`);
    return;
  }

  try {
    await postToDiscord(webhookUrl, payload);
    console.log('[notify-discord] Posted notification.');
  } catch (err) {
    console.warn(
      `[notify-discord] Failed to post (non-fatal): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

if (process.argv[1] === __filename) {
  void main();
}
```

- [ ] **Step 2: Verify existing tests still pass (no regression)**

Run: `npm run test:notify`
Expected: PASS — all 8 tests still green (adding exports/main must not break imports).

- [ ] **Step 3: Manual smoke test — no webhook URL is a safe no-op**

Run: `unset DISCORD_PDC_WEBHOOK_URL; node --import tsx scripts/notify-discord.ts --event=ingested --episode=293; echo "exit=$?"`
Expected: prints `[notify-discord] DISCORD_PDC_WEBHOOK_URL not set — skipping.` and `exit=0`.

- [ ] **Step 4: Manual smoke test — real post (optional, needs a test webhook)**

Only if you have a throwaway webhook URL for a test channel:

Run:
```bash
DISCORD_PDC_WEBHOOK_URL="<test-webhook-url>" \
  node --import tsx scripts/notify-discord.ts --event=needs-mapping --episodes=293
```
Expected: prints `[notify-discord] Posted notification.` and a single amber embed titled `Ep 293 · Panic Room (2002)` with a `Reviewer: birria` field appears in the test channel, linking to `/review/293`.

Then test the ingested path:
```bash
DISCORD_PDC_WEBHOOK_URL="<test-webhook-url>" \
  node --import tsx scripts/notify-discord.ts --event=ingested --episode=293
```
Expected: a single green embed `✅ Ingested into search corpus` appears.

- [ ] **Step 5: Commit**

```bash
git add scripts/notify-discord.ts
git commit -m "feat(notify): webhook POST + CLI entrypoint for episode notifications"
```

---

## Task 4: Wire the notifier into both workflows

**Files:**
- Modify: `.github/workflows/new-episodes.yml`
- Modify: `.github/workflows/ingest-episode.yml`

**Interfaces:**
- Consumes: `scripts/notify-discord.ts` CLI (Task 3). Requires the `DISCORD_PDC_WEBHOOK_URL` GitHub Actions secret to exist (operator step — see Task 5 notes; absent secret is a safe no-op).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the Event 1 step to `new-episodes.yml`**

In `.github/workflows/new-episodes.yml`, insert this step **immediately after** the `- name: Commit metadata and transcript changes` step and **before** `- name: Trigger deploy`:

```yaml
      # Announce freshly-transcribed episodes that now need speaker mapping.
      # Non-fatal: the script exits 0 if the webhook secret is unset or the
      # POST fails, so notification problems never block the deploy.
      - name: Notify Discord — episodes need speaker mapping
        if: hashFiles('transcribed-episodes.txt') != ''
        continue-on-error: true
        env:
          DISCORD_PDC_WEBHOOK_URL: ${{ secrets.DISCORD_PDC_WEBHOOK_URL }}
        run: node --import tsx ./scripts/notify-discord.ts --event=needs-mapping
```

- [ ] **Step 2: Add the Event 2 step to `ingest-episode.yml`**

In `.github/workflows/ingest-episode.yml`, insert this step **immediately after** the `- name: Upload updated search index` step and **before** `- name: Trigger deploy`:

```yaml
      # Announce that the episode is now searchable (speaker mapping + cleanup
      # complete). Non-fatal — never blocks the deploy.
      - name: Notify Discord — episode ingested
        continue-on-error: true
        env:
          DISCORD_PDC_WEBHOOK_URL: ${{ secrets.DISCORD_PDC_WEBHOOK_URL }}
          EPISODE: ${{ inputs.episode }}
        run: node --import tsx ./scripts/notify-discord.ts --event=ingested --episode="$EPISODE"
```

- [ ] **Step 3: Validate the YAML parses**

Run:
```bash
node --import tsx -e "import('node:fs').then(fs => { const yaml = fs.readFileSync('.github/workflows/new-episodes.yml','utf8'); const yaml2 = fs.readFileSync('.github/workflows/ingest-episode.yml','utf8'); console.log('new-episodes step present:', yaml.includes('Notify Discord — episodes need speaker mapping')); console.log('ingest step present:', yaml2.includes('Notify Discord — episode ingested')); })"
```
Expected: both lines print `true`.

If `yamllint` is available, also run `yamllint .github/workflows/new-episodes.yml .github/workflows/ingest-episode.yml` and expect no syntax errors (indentation warnings are acceptable).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/new-episodes.yml .github/workflows/ingest-episode.yml
git commit -m "ci(notify): post Discord notifications on transcribe + ingest"
```

---

## Task 5: Operator setup notes + push

**Files:**
- Modify: `docs/superpowers/specs/2026-07-01-discord-episode-notifications-design.md` (append an "Implemented" note referencing the setup checklist) — OR create `scripts/notify-discord.README.md` if you prefer a co-located runbook. Choose one; the content below is the same either way.

**Interfaces:**
- Consumes: nothing. Documentation + deployment only.
- Produces: nothing.

- [ ] **Step 1: Record the one-time operator setup**

The webhook + secret are a manual, one-time operator action (cannot be scripted from here). Document it. Append to the design doc under a new `## Operator setup (one-time)` heading (or create `scripts/notify-discord.README.md` with the same content):

```markdown
## Operator setup (one-time)

1. In Discord: `#pod-data-central` → **Edit Channel → Integrations →
   Webhooks → New Webhook**. Name it after the bot, set the bot's avatar,
   and **Copy Webhook URL**.
2. In GitHub (`jbennygold/transcript-app`): **Settings → Secrets and
   variables → Actions → New repository secret**. Name:
   `DISCORD_PDC_WEBHOOK_URL`, value: the copied URL.

Until this secret exists the notify steps run as a safe no-op (they log a
warning and exit 0). No other configuration is required.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-07-01-discord-episode-notifications-design.md
git commit -m "docs(notify): operator setup for Discord webhook secret"
```

- [ ] **Step 3: Push to master**

Per repo workflow (always push to master, no PRs):

```bash
git pull --rebase origin master && git push origin master
```
Expected: push succeeds. If the daily `new-episodes` cron has landed a commit, the rebase replays cleanly (no overlap with these files).

- [ ] **Step 4: Post-merge verification (operator, after the secret is set)**

- Manually run the **Ingest Episode** workflow (Actions → Ingest Episode → Run workflow) for a recently-published episode number, and confirm the green "Ingested into search corpus" embed appears in `#pod-data-central`.
- The Event 1 amber batch will appear on the next daily `new-episodes` cron that transcribes at least one episode (or trigger `new-episodes` manually via workflow_dispatch to exercise it sooner). Note: Event 1 only posts when `transcribed-episodes.txt` is non-empty, i.e. at least one new episode was transcribed that run.

---

## Self-Review Notes

**Spec coverage:**
- Event 1 (needs mapping, batched, amber, per-episode embeds, /review link) → Tasks 1, 3, 4.
- Event 2 (ingested, green, single embed, search link) → Tasks 1, 3, 4.
- Webhook delivery + `DISCORD_PDC_WEBHOOK_URL` secret → Tasks 3, 4, 5.
- Title resolution from metadata + fallback → Task 2.
- Never-fail-CI behavior → Task 1 (Global Constraints), Task 3 (no-op paths), Task 4 (`continue-on-error`).
- No-dupe-pings (per-run set) → Task 3 (`transcribed-episodes.txt` reader), Task 4 (`if: hashFiles(...)`).
- >10-episode overflow → Task 1 (test + impl).
- No new deps → uses `node:*` + `fetch` only.

**Type consistency:** `EpisodeInfo`/`WebhookPayload`/`DiscordEmbed`, `AMBER`/`GREEN`, `buildNeedsMappingMessage`, `buildIngestedMessage`, `resolveEpisodes`, `postToDiscord` are named identically across all tasks.

**Placeholder scan:** No TBD/TODO; every code and command step is concrete.
