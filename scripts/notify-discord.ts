// Posts episode-lifecycle notifications to the #pod-data-central Discord
// channel via an incoming webhook. Invoked from GitHub Actions. Never fails CI.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
