// Posts episode-lifecycle notifications to the #pod-data-central Discord
// channel via an incoming webhook. Invoked from GitHub Actions. Never fails CI.

import fs from 'node:fs';

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
