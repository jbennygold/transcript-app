# Discord `/pdc-check-episodes` Trigger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a role-gated `/pdc-check-episodes` Discord slash command that triggers the `new-episodes.yml` GitHub Action via the `workflow_dispatch` REST API.

**Architecture:** All code lands in the `transcript-bot` repo (discord.js v14 on Railway). The GitHub API call is isolated in a pure, dependency-injectable helper (`src/github-dispatch.ts`) that is unit-tested with Node's built-in `node:test` runner. The Discord command registration and the interaction handler (including the role gate) are wired into the existing bot files and verified manually against Discord. The target GitHub workflow already supports `workflow_dispatch` and is **not** modified.

**Tech Stack:** TypeScript (ES modules, `moduleResolution: Bundler`, strict), discord.js v14, tsx, Node 20, GitHub REST API, Railway env.

## Global Constraints

- **All code changes are in the `transcript-bot` repo** at `/opt/projects/transcript-bot`. This plan file lives in `transcript-app` only because that is where specs/plans are kept.
- **ES module import specifiers use the `.js` extension** even for TypeScript files (existing convention, e.g. `import ... from '../src/share-summary.js'`). Match it.
- **No new npm dependencies.** Tests use the built-in `node:test` + `node:assert/strict`. Run test files with `node --import tsx --test <file>`.
- **Target repo is `jbennygold/transcript-app`, branch `master`, workflow file `new-episodes.yml`.** These are fixed string literals.
- **GitHub `workflow_dispatch` success is HTTP `204 No Content`.** Any other status is a failure.
- **Never echo the token or a raw GitHub error body** into a Discord reply.
- **Role gate:** only members with the Discord role named by `EPISODE_TRIGGER_ROLE` (default `hosts`) may trigger. Denials are ephemeral.
- **Graceful degradation:** if `GITHUB_DISPATCH_TOKEN` is unset, the command replies ephemerally that it is not configured and does not throw (matches the bot's convention for optional services).

---

### Task 1: GitHub dispatch helper (pure, unit-tested)

Isolate the GitHub API call in a testable helper with an injectable `fetch` so it can be unit-tested without network access.

**Files:**
- Create: `/opt/projects/transcript-bot/src/github-dispatch.ts`
- Test: `/opt/projects/transcript-bot/src/github-dispatch.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `interface DispatchResult { ok: boolean; status: number }`
  - `async function triggerNewEpisodesWorkflow(token: string, fetchFn?: typeof fetch): Promise<DispatchResult>` — POSTs the `workflow_dispatch` request; `ok` is true iff HTTP status is 204. `fetchFn` defaults to the global `fetch` and exists so tests can inject a fake.

- [ ] **Step 1: Write the failing test**

Create `/opt/projects/transcript-bot/src/github-dispatch.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { triggerNewEpisodesWorkflow } from './github-dispatch.js';

function fakeFetch(status: number, capture?: (url: string, init: RequestInit) => void) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture?.(String(url), init ?? {});
    return new Response(null, { status });
  }) as unknown as typeof fetch;
}

test('returns ok on 204 and posts to the correct endpoint with ref master', async () => {
  let seenUrl = '';
  let seenInit: RequestInit = {};
  const result = await triggerNewEpisodesWorkflow(
    'tok_abc',
    fakeFetch(204, (url, init) => {
      seenUrl = url;
      seenInit = init;
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 204);
  assert.equal(
    seenUrl,
    'https://api.github.com/repos/jbennygold/transcript-app/actions/workflows/new-episodes.yml/dispatches',
  );
  assert.equal(seenInit.method, 'POST');
  const headers = seenInit.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer tok_abc');
  assert.equal(headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.deepEqual(JSON.parse(String(seenInit.body)), { ref: 'master' });
});

test('returns not-ok on a non-204 status', async () => {
  const result = await triggerNewEpisodesWorkflow('tok_bad', fakeFetch(401));
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /opt/projects/transcript-bot && node --import tsx --test src/github-dispatch.test.ts`
Expected: FAIL — cannot resolve `./github-dispatch.js` / `triggerNewEpisodesWorkflow` is not defined.

- [ ] **Step 3: Write the minimal implementation**

Create `/opt/projects/transcript-bot/src/github-dispatch.ts`:

```ts
const DISPATCH_URL =
  'https://api.github.com/repos/jbennygold/transcript-app/actions/workflows/new-episodes.yml/dispatches';

export interface DispatchResult {
  ok: boolean;
  status: number;
}

/**
 * Trigger the "Check New Episodes" GitHub Action via workflow_dispatch.
 * Success is HTTP 204 No Content. `fetchFn` is injectable for testing.
 */
export async function triggerNewEpisodesWorkflow(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<DispatchResult> {
  const res = await fetchFn(DISPATCH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'transcript-bot',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'master' }),
  });
  return { ok: res.status === 204, status: res.status };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /opt/projects/transcript-bot && node --import tsx --test src/github-dispatch.test.ts`
Expected: PASS — `# pass 2`, `# fail 0`.

- [ ] **Step 5: Typecheck**

Run: `cd /opt/projects/transcript-bot && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /opt/projects/transcript-bot
git add src/github-dispatch.ts src/github-dispatch.test.ts
git commit -m "feat(bot): add GitHub workflow_dispatch helper for new-episodes"
```

---

### Task 2: Register the `/pdc-check-episodes` slash command

Add the command definition so Discord knows about it.

**Files:**
- Modify: `/opt/projects/transcript-bot/scripts/discord-register.ts` (add builder + append to `commands` array)

**Interfaces:**
- Consumes: nothing.
- Produces: a registered global (or guild) command named `pdc-check-episodes` with no options.

- [ ] **Step 1: Add the command builder**

In `/opt/projects/transcript-bot/scripts/discord-register.ts`, immediately after the `playlistCommand` definition (ends at the line before `const commands = [`), add:

```ts
const checkEpisodesCommand = new SlashCommandBuilder()
  .setName('pdc-check-episodes')
  .setDescription('Check the podcast feed for new episodes and start transcription');
```

- [ ] **Step 2: Append it to the `commands` array**

Change the `commands` array so its last entry includes the new command:

```ts
const commands = [
  command.toJSON(),
  quoteCommand.toJSON(),
  synopsisCommand.toJSON(),
  tildaCommand.toJSON(),
  guestCommand.toJSON(),
  kevCommand.toJSON(),
  statsCommand.toJSON(),
  crewCommand.toJSON(),
  playlistCommand.toJSON(),
  checkEpisodesCommand.toJSON(),
];
```

- [ ] **Step 3: Typecheck**

Run: `cd /opt/projects/transcript-bot && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Register against Discord (requires live creds)**

Run: `cd /opt/projects/transcript-bot && npm run register`
Expected: prints `Registered /pdc command ...` and exits 0. In a Discord client, typing `/pdc-check-episodes` now shows the command.

> If Discord credentials are not available in this environment, skip Step 4 and note that `npm run register` must be run during deploy. The typecheck in Step 3 is the automated gate.

- [ ] **Step 5: Commit**

```bash
cd /opt/projects/transcript-bot
git add scripts/discord-register.ts
git commit -m "feat(bot): register /pdc-check-episodes slash command"
```

---

### Task 3: Wire the handler + role gate into the bot

Handle the command: gate on the `hosts` role, call the Task 1 helper, report back.

**Files:**
- Modify: `/opt/projects/transcript-bot/scripts/discord-bot.ts`
  - Add import of the Task 1 helper (top, near line 15).
  - Add the `EPISODE_TRIGGER_ROLE` env constant (config block, near line 25).
  - Add the command branch inside the `isChatInputCommand()` block (after the `pdc-playlist` branch, before the closing `}` at line 796).

**Interfaces:**
- Consumes: `triggerNewEpisodesWorkflow(token, fetchFn?)` and `DispatchResult` from `../src/github-dispatch.js` (Task 1).
- Produces: user-facing behavior only.

- [ ] **Step 1: Import the helper**

In `/opt/projects/transcript-bot/scripts/discord-bot.ts`, directly below the existing `import { summarizeShareAnswer } from '../src/share-summary.js';` (line 15), add:

```ts
import { triggerNewEpisodesWorkflow } from '../src/github-dispatch.js';
```

- [ ] **Step 2: Add the config constant**

In the config block near line 25 (after the `clippyWebUrl` line), add:

```ts
const githubDispatchToken = process.env.GITHUB_DISPATCH_TOKEN || '';
const episodeTriggerRole = process.env.EPISODE_TRIGGER_ROLE || 'hosts';
const episodesRunUrl =
  'https://github.com/jbennygold/transcript-app/actions/workflows/new-episodes.yml';
```

- [ ] **Step 3: Add the command handler branch**

In `discord-bot.ts`, inside the `if (interaction.isChatInputCommand()) {` block, immediately after the `pdc-playlist` branch closes (the `}` on line 795, before the block's own closing `}` on line 796), insert:

```ts
      if (interaction.commandName === 'pdc-check-episodes') {
        // Role gate. inCachedGuild() narrows interaction.member to a GuildMember
        // whose roles.cache is populated (guilds are cached under the Guilds intent).
        if (!interaction.inCachedGuild()) {
          await interaction.reply({
            content: 'This command can only be used inside a server.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const hasRole = interaction.member.roles.cache.some(
          (r) => r.name.toLowerCase() === episodeTriggerRole.toLowerCase(),
        );
        if (!hasRole) {
          await interaction.reply({
            content: `You need the **${episodeTriggerRole}** role to run this.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (!githubDispatchToken) {
          await interaction.reply({
            content: 'Episode trigger isn’t configured (missing GITHUB_DISPATCH_TOKEN).',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.deferReply();
        try {
          const result = await triggerNewEpisodesWorkflow(githubDispatchToken);
          if (result.ok) {
            await interaction.editReply({
              content:
                `✅ Started a new-episodes check. Follow it here: ${episodesRunUrl}\n` +
                'Results will be posted to #pod-data-central when transcription finishes.',
            });
          } else {
            await interaction.editReply({
              content: `❌ GitHub rejected the trigger (HTTP ${result.status}). Check the token and try again.`,
            });
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Unknown error';
          await interaction.editReply({
            content: `❌ Failed to trigger the workflow: ${msg}`,
          });
        }
        return;
      }
```

- [ ] **Step 4: Typecheck**

Run: `cd /opt/projects/transcript-bot && npx tsc --noEmit`
Expected: no errors. (Confirms `interaction.inCachedGuild()` narrowing and `roles.cache` typecheck cleanly.)

- [ ] **Step 5: Manual verification (requires live bot + Discord)**

Start the bot (`npm run bot`) with `GITHUB_DISPATCH_TOKEN` set to a valid fine-grained PAT and `EPISODE_TRIGGER_ROLE` unset (defaults to `hosts`):
  1. As a member **without** the `hosts` role, run `/pdc-check-episodes` → ephemeral "You need the **hosts** role to run this." No run appears in GitHub Actions.
  2. As a member **with** the `hosts` role, run `/pdc-check-episodes` → non-ephemeral "✅ Started..." with the run link, and a new run appears at the top of the `new-episodes.yml` Actions list.
  3. Temporarily unset `GITHUB_DISPATCH_TOKEN` and restart → command replies ephemerally "isn't configured", no run started.

> If a live bot is not available in this environment, the Step 4 typecheck is the automated gate; record that Step 5 must be exercised on Railway after deploy.

- [ ] **Step 6: Commit**

```bash
cd /opt/projects/transcript-bot
git add scripts/discord-bot.ts
git commit -m "feat(bot): handle /pdc-check-episodes with hosts-role gate"
```

---

### Task 4: Configuration docs + env template

Document the two new env vars so the deploy is reproducible.

**Files:**
- Modify: `/opt/projects/transcript-bot/CLAUDE.md` (Environment Variables section)
- Modify: `/opt/projects/transcript-bot/.env.local` (add commented placeholders — this file is gitignored per the repo's `.gitignore`, so it is a local template only)

**Interfaces:**
- Consumes: nothing.
- Produces: documentation only.

- [ ] **Step 1: Document the env vars in CLAUDE.md**

In `/opt/projects/transcript-bot/CLAUDE.md`, under `## Environment Variables`, add these two bullets at the end of the list:

```markdown
- `GITHUB_DISPATCH_TOKEN` — fine-grained GitHub PAT (scope: `jbennygold/transcript-app`, **Actions: Read and write**) used to trigger the `new-episodes.yml` workflow from `/pdc-check-episodes`
- `EPISODE_TRIGGER_ROLE` — Discord role name allowed to run `/pdc-check-episodes` (defaults to `hosts`)
```

- [ ] **Step 2: Add placeholders to the local env template**

Append to `/opt/projects/transcript-bot/.env.local`:

```
# Trigger for the new-episodes GitHub Action (/pdc-check-episodes)
GITHUB_DISPATCH_TOKEN=
EPISODE_TRIGGER_ROLE=hosts
```

- [ ] **Step 3: Commit**

```bash
cd /opt/projects/transcript-bot
git add CLAUDE.md
git commit -m "docs(bot): document GITHUB_DISPATCH_TOKEN and EPISODE_TRIGGER_ROLE"
```

> `.env.local` is gitignored and is not committed; it is edited only as a local convenience.

---

## Manual setup (outside code — performed by the user during deploy)

These are prerequisites for Task 3 Step 5 and for production to work. They are not code steps:

1. **Create a fine-grained PAT** in GitHub: Settings → Developer settings → Fine-grained tokens. Repository access: **only** `jbennygold/transcript-app`. Permissions: **Actions → Read and write**. Copy the token.
2. **Add env vars on Railway** for the `transcript-bot` service: `GITHUB_DISPATCH_TOKEN=<the PAT>` and (optionally) `EPISODE_TRIGGER_ROLE` if the role should differ from `hosts`.
3. **Run `npm run register`** (Task 2 Step 4) once against Discord so the command is published, then redeploy the bot so the new handler is live.

---

## Self-Review

**Spec coverage:**
- New slash command (no options, recent-only) → Task 2. ✓
- Role gate on `hosts` via `EPISODE_TRIGGER_ROLE` → Task 3 Step 3. ✓
- `workflow_dispatch` POST with `{"ref":"master"}`, 204 = success → Task 1. ✓
- Confirmation + run-list link; completion via existing webhook → Task 3 Step 3. ✓
- Graceful "not configured" when token missing → Task 3 Step 3. ✓
- Non-204 / exception handled without secret leakage → Task 1 + Task 3 Step 3. ✓
- Two env vars documented → Task 4. ✓
- No change to `new-episodes.yml` → confirmed; no task touches it. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases" — all steps contain concrete code or exact commands. ✓

**Type consistency:** `triggerNewEpisodesWorkflow(token, fetchFn?)` and `DispatchResult` are defined in Task 1 and consumed with the same signature in Task 3. `episodeTriggerRole`, `githubDispatchToken`, `episodesRunUrl` are defined once (Task 3 Step 2) and used in Task 3 Step 3. ✓
