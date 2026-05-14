/**
 * Podcast RSS feed loader.
 *
 * Used as a fallback audio source when an episode isn't available in Google
 * Drive yet (typically older episodes the team never uploaded, or new episodes
 * that have published to RSS before being filed to Drive).
 *
 * Matching strategy: the Anchor.fm feed's <title> equals the metadata `film`
 * field verbatim (e.g. "The Last Starfighter (1984)"), so a normalized title
 * compare is reliable. itunes:episode is season-relative on this feed and
 * cannot be used for global numbering.
 */

import * as fs from 'fs';

const DEFAULT_RSS_URL = 'https://anchor.fm/s/238d77c8/podcast/rss';
const FETCH_USER_AGENT = 'transcript-app/1.0 (RSS fallback)';

export interface PodcastFeedItem {
  title: string;
  pubDate: string;
  enclosureUrl: string;
  enclosureType: string;
}

export function getFeedUrl(): string {
  return process.env.PODCAST_RSS_URL || DEFAULT_RSS_URL;
}

export async function fetchPodcastFeed(
  rssUrl?: string,
): Promise<PodcastFeedItem[]> {
  const url = rssUrl || getFeedUrl();
  const res = await fetch(url, { headers: { 'User-Agent': FETCH_USER_AGENT } });
  if (!res.ok) {
    throw new Error(`Failed to fetch RSS feed ${url}: HTTP ${res.status}`);
  }
  const xml = await res.text();
  return parseRssItems(xml);
}

function parseRssItems(xml: string): PodcastFeedItem[] {
  const items: PodcastFeedItem[] = [];
  const itemRe = /<item\b[\s\S]*?<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[0];
    const title = extractTag(block, 'title');
    const pubDate = extractTag(block, 'pubDate');
    const enc = /<enclosure\b([^>]+?)\/?\s*>/.exec(block);
    if (!enc) continue;
    const urlMatch = /url=["']([^"']+)["']/.exec(enc[1]);
    if (!urlMatch) continue;
    const typeMatch = /type=["']([^"']+)["']/.exec(enc[1]);
    items.push({
      title: title ?? '',
      pubDate: pubDate ?? '',
      enclosureUrl: urlMatch[1],
      enclosureType: typeMatch ? typeMatch[1] : 'audio/mpeg',
    });
  }
  return items;
}

function extractTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`);
  const m = re.exec(block);
  if (!m) return null;
  return decodeXmlText(stripCdata(m[1])).trim();
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function decodeXmlText(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findItemByFilm(
  items: PodcastFeedItem[],
  film: string,
): PodcastFeedItem | null {
  const target = normalizeTitle(film);
  if (!target) return null;
  for (const it of items) {
    if (normalizeTitle(it.title) === target) return it;
  }
  for (const it of items) {
    const t = normalizeTitle(it.title);
    if (t && (t.includes(target) || target.includes(t))) return it;
  }
  return null;
}

export async function downloadEnclosureToFile(
  enclosureUrl: string,
  destPath: string,
): Promise<void> {
  const res = await fetch(enclosureUrl, {
    headers: { 'User-Agent': FETCH_USER_AGENT },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(
      `Failed to download enclosure ${enclosureUrl}: HTTP ${res.status}`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(destPath, buf);
}
