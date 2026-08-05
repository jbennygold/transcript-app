// Posts episode-lifecycle notifications to the #pod-data-central Discord
// channel via an incoming webhook. Invoked from GitHub Actions. Never fails CI.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UnresolvedEpisode } from '../src/lib/drive-match';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  episodes: EpisodeInfo[]
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
      color: AMBER,
    };
    if (e.reviewer) {
      embed.fields = [{ name: 'Reviewer', value: e.reviewer, inline: true }];
    }
    return embed;
  });

  return { content, embeds };
}

export function buildNoNewEpisodesMessage(): WebhookPayload {
  return {
    content: '✅ Checked the feed — no new episodes. Everything is up to date.',
    embeds: [],
  };
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

export function buildDriveUnresolvedMessage(unresolved: UnresolvedEpisode[]): WebhookPayload {
  const plural = unresolved.length === 1 ? '' : 's';
  return {
    content: `⚠️ ${unresolved.length} episode${plural} had no matching audio folder in Drive`,
    embeds: unresolved.slice(0, 10).map(u => ({
      title: `Ep ${u.episode} · ${u.film}`,
      description:
        u.suggestions.length > 0
          ? `No folder matched. Closest names in Drive:\n${u.suggestions.map(s => `• ${s}`).join('\n')}`
          : 'No folder matched, and nothing in Drive came close.',
      color: AMBER,
    })),
  };
}

export function buildProposalsReadyMessage(
  episode: string,
  film: string,
  count: number,
  baseUrl: string
): WebhookPayload {
  return {
    content: `📝 ${count} metadata proposal${count === 1 ? '' : 's'} ready to review`,
    embeds: [
      {
        title: `Ep ${episode} · ${film}`,
        url: `${baseUrl}/podreview`,
        description: 'Extracted from the transcript. Accept or reject each field in /podreview — nothing is written to the sheet until you do.',
        color: AMBER,
      },
    ],
  };
}

export function buildNotesOpenMessage(episode: string, film: string): WebhookPayload {
  const title = film.trim() === '' ? `Episode ${episode}` : `Ep ${episode} · ${film}`;
  return {
    content: '🗒️ Notable Moment nominations are open',
    embeds: [
      {
        title,
        description:
          'This episode is now open for Notable Moments.\n\n' +
          '**Reply in this thread** with any moment worth recording — one per message, as many as you like.\n' +
          'An admin reacts ✅ to the ones that should go in the sheet, then runs `/pdc-sync-notes`.\n\n' +
          'Thought of one later, outside the thread? `/pdc-note note: Haitch\'s Roy Scheider tangent around 42:00` still works.',
        color: AMBER,
      },
    ],
  };
}

export type NotesOpenTransport =
  | { kind: 'bot'; token: string; channelId: string }
  | { kind: 'webhook'; url: string }
  | { kind: 'none' };

/**
 * The bot path is preferred because only a bot token can create the thread
 * comments are collected in. The webhook is kept as a fallback so a
 * half-configured bot degrades to a threadless announcement rather than
 * silence — DISCORD_ENGINEERS_WEBHOOK_URL is no longer required, but is still
 * honoured while the migration lands.
 */
export function notesOpenTransport(env: Record<string, string | undefined>): NotesOpenTransport {
  const token = env.DISCORD_BOT_TOKEN;
  const channelId = env.DISCORD_ENGINEERS_CHANNEL_ID;
  if (token && channelId) return { kind: 'bot', token, channelId };
  const url = env.DISCORD_ENGINEERS_WEBHOOK_URL;
  if (url) return { kind: 'webhook', url };
  return { kind: 'none' };
}

/**
 * Discord webhooks are channel-scoped, so each event posts through the webhook
 * for its channel. notes-open goes to #engineers; everything else to
 * #pod-data-central.
 */
export function webhookForEvent(
  event: string,
  env: Record<string, string | undefined>
): string | undefined {
  return event === 'notes-open'
    ? env.DISCORD_ENGINEERS_WEBHOOK_URL
    : env.DISCORD_PDC_WEBHOOK_URL;
}

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

/**
 * Resolve the film to announce for notes-open. An explicit --film always
 * wins (it's an override); otherwise look the episode up in metadata, the
 * same way the 'ingested' event does via resolveEpisodes.
 */
export function resolveNotesOpenFilm(
  ep: string,
  filmArg: string | undefined,
  metadataPath: string
): string {
  if (filmArg !== undefined) return filmArg;
  const epNum = Number(ep);
  if (!Number.isInteger(epNum)) return '';
  return resolveEpisodes([epNum], metadataPath)[0]?.film ?? '';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const event = getArg(args, 'event') ?? '';
  const baseUrl = (
    process.env.NEXT_PUBLIC_BASE_URL || 'https://search.escapehatchpod.com'
  ).replace(/\/+$/, '');
  const metadataPath = path.resolve(__dirname, '..', 'data', 'episode-metadata.json');

  if (event === 'notes-open') {
    const ep = getArg(args, 'episode')?.replace(/^episode_/, '').trim();
    if (!ep) {
      console.warn('[notify-discord] notes-open needs --episode — skipping.');
      return;
    }
    const film = resolveNotesOpenFilm(ep, getArg(args, 'film'), metadataPath);

    // Announce first, because the thread id it produces goes on the pointer.
    // Every failure below is non-fatal and leaves threadId null.
    let threadId: string | null = null;
    const transport = notesOpenTransport(process.env);

    if (transport.kind === 'bot') {
      const { announceWithThread, threadNameFor } = await import('../src/lib/discord-thread');
      const result = await announceWithThread({
        token: transport.token,
        channelId: transport.channelId,
        payload: buildNotesOpenMessage(ep, film),
        threadName: threadNameFor(ep, film),
      });
      threadId = result?.threadId ?? null;
      if (result && threadId) console.log(`[notify-discord] Posted announcement and opened thread ${threadId}.`);
      else if (result) console.warn('[notify-discord] Announced, but the thread was not created.');
    } else if (transport.kind === 'webhook') {
      console.warn('[notify-discord] No bot token/channel id — posting via webhook, so no thread.');
      try {
        await postToDiscord(transport.url, buildNotesOpenMessage(ep, film));
        console.log('[notify-discord] Posted notification.');
      } catch (err) {
        console.warn(
          `[notify-discord] Failed to post (non-fatal): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } else {
      console.warn('[notify-discord] Neither DISCORD_BOT_TOKEN+DISCORD_ENGINEERS_CHANNEL_ID nor DISCORD_ENGINEERS_WEBHOOK_URL is set — skipping the announcement.');
    }

    // Unconditional, and deliberately AFTER the announcement but outside every
    // early return: the pointer write needs only BLOB_READ_WRITE_TOKEN, and
    // gating it behind a Discord secret silently broke /pdc-note for every
    // contributor once already. A null threadId is a valid pointer.
    try {
      const { setOpenEpisode } = await import('../src/lib/episode-notes');
      await setOpenEpisode({ episode: ep, film, openedAt: new Date().toISOString(), threadId });
    } catch (err) {
      console.warn(
        `[notify-discord] could not record open episode: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return;
  }

  const webhookUrl = webhookForEvent(event, process.env);
  if (!webhookUrl) {
    console.warn('[notify-discord] DISCORD_PDC_WEBHOOK_URL not set — skipping.');
    return;
  }

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
    payload = buildNeedsMappingMessage(resolveEpisodes(numbers, metadataPath));
  } else if (event === 'ingested') {
    const epArg = getArg(args, 'episode');
    // The ingest workflow passes the app's episode identifier ("episode_313"),
    // so strip the prefix — matching ingest.ts — before coercing to a number.
    const episode = Number(String(epArg ?? '').replace(/^episode_/, '').trim());
    if (!Number.isInteger(episode)) {
      console.warn(`[notify-discord] --episode must resolve to a number (got "${epArg}") — skipping.`);
      return;
    }
    payload = buildIngestedMessage(resolveEpisodes([episode], metadataPath)[0], baseUrl);
  } else if (event === 'no-new-episodes') {
    payload = buildNoNewEpisodesMessage();
  } else if (event === 'drive-unresolved') {
    const reportPath = path.resolve(__dirname, '..', 'unresolved-episodes.json');
    if (!fs.existsSync(reportPath)) {
      console.warn('[notify-discord] No unresolved-episodes.json — skipping.');
      return;
    }
    const unresolved: UnresolvedEpisode[] = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    if (unresolved.length === 0) {
      console.warn('[notify-discord] unresolved-episodes.json is empty — skipping.');
      return;
    }
    payload = buildDriveUnresolvedMessage(unresolved);
  } else if (event === 'proposals-ready') {
    const episode = getArg(args, 'episode')?.replace(/^episode_/, '').trim();
    const film = getArg(args, 'film') ?? '';
    const count = parseInt(getArg(args, 'count') ?? '0', 10);
    if (!episode || count <= 0) {
      console.warn('[notify-discord] proposals-ready needs --episode and a positive --count — skipping.');
      return;
    }
    payload = buildProposalsReadyMessage(episode, film, count, baseUrl);
  } else {
    console.warn(`[notify-discord] Unknown --event "${event}" — expected needs-mapping, ingested, no-new-episodes, drive-unresolved, notes-open, or proposals-ready.`);
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
