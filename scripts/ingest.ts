import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import OpenAI from 'openai';
import * as dotenv from 'dotenv';
import { list, put } from '@vercel/blob';
import Anthropic from '@anthropic-ai/sdk';
import { CostTracker } from '../src/lib/llm-cost';

// Load environment variables
dotenv.config({ path: '.env.local' });

// ============================================
// BM25 Implementation (inlined to avoid import issues)
// ============================================

interface BM25Document {
  id: string;
  text: string;
  metadata: {
    episodeTitle: string;
    speakers: string;
    startTimestamp: string;
    endTimestamp: string;
  };
}

interface BM25Index {
  df: Record<string, number>;
  invertedIndex: Record<string, [number, number][]>;
  docLengths: number[];
  avgDocLength: number;
  numDocs: number;
  docIds: string[];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function buildBM25Index(documents: BM25Document[]): BM25Index {
  const df: Record<string, number> = {};
  const invertedIndex: Record<string, [number, number][]> = {};
  const docLengths: number[] = [];
  const docIds: string[] = [];
  let totalLength = 0;

  documents.forEach((doc, docIndex) => {
    const tokens = tokenize(doc.text);
    docLengths.push(tokens.length);
    docIds.push(doc.id);
    totalLength += tokens.length;

    const termFreqs: Record<string, number> = {};
    for (const token of tokens) {
      termFreqs[token] = (termFreqs[token] || 0) + 1;
    }

    for (const [term, freq] of Object.entries(termFreqs)) {
      if (!invertedIndex[term]) {
        invertedIndex[term] = [];
        df[term] = 0;
      }
      invertedIndex[term].push([docIndex, freq]);
      df[term]++;
    }
  });

  return {
    df,
    invertedIndex,
    docLengths,
    avgDocLength: documents.length > 0 ? totalLength / documents.length : 0,
    numDocs: documents.length,
    docIds,
  };
}

// ============================================

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface DialogueEntry {
  name: string;
  timestamp: string;
  text: string;
}

interface Transcript {
  episode_number?: number;
  episode_name: string;
  dialogues: DialogueEntry[];
}

interface Chunk {
  id: string;
  text: string;
  episodeTitle: string;
  speakers: string[];
  startTimestamp: string;
  endTimestamp: string;
}

interface StoredChunk {
  id: string;
  text: string;
  embedding: number[];
  metadata: {
    episodeTitle: string;
    speakers: string;
    startTimestamp: string;
    endTimestamp: string;
  };
}

const TRANSCRIPTS_DIR = './transcripts';
const STORE_PATH = './vector-store.json';
const BM25_STORE_PATH = './bm25-index.json';
const SEARCH_DATA_PREFIX = 'search-data/';
const MANIFEST_PATH = `${SEARCH_DATA_PREFIX}ingest-manifest.json`;
const TARGET_CHUNK_SIZE = 500;
const OVERLAP_SIZE = 50;
const SKIP_IF_NO_NEW = process.env.SKIP_INGEST_IF_NO_NEW === '1'
  || process.env.SKIP_INGEST_IF_NO_NEW === 'true';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function chunkTranscript(transcript: Transcript): Chunk[] {
  const chunks: Chunk[] = [];
  const dialogues = transcript.dialogues;

  if (!dialogues || dialogues.length === 0) return chunks;

  let currentChunk: DialogueEntry[] = [];
  let currentTokens = 0;
  let chunkIndex = 0;

  for (let i = 0; i < dialogues.length; i++) {
    const entry = dialogues[i];
    const entryTokens = estimateTokens(`${entry.name}: ${entry.text}`);

    if (currentTokens + entryTokens > TARGET_CHUNK_SIZE * 4 && currentChunk.length > 0) {
      const chunkText = currentChunk
        .map((e) => `[${e.timestamp}] ${e.name}: ${e.text}`)
        .join('\n');
      const speakers = [...new Set(currentChunk.map((e) => e.name))];

      chunks.push({
        id: `${transcript.episode_name.replace(/[^a-zA-Z0-9]/g, '_')}_${chunkIndex}`,
        text: chunkText,
        episodeTitle: transcript.episode_name,
        speakers,
        startTimestamp: currentChunk[0].timestamp,
        endTimestamp: currentChunk[currentChunk.length - 1].timestamp,
      });

      chunkIndex++;

      const overlapEntries: DialogueEntry[] = [];
      let overlapTokens = 0;
      for (let j = currentChunk.length - 1; j >= 0 && overlapTokens < OVERLAP_SIZE * 4; j--) {
        overlapEntries.unshift(currentChunk[j]);
        overlapTokens += estimateTokens(`${currentChunk[j].name}: ${currentChunk[j].text}`);
      }
      currentChunk = overlapEntries;
      currentTokens = overlapTokens;
    }

    currentChunk.push(entry);
    currentTokens += entryTokens;
  }

  if (currentChunk.length > 0) {
    const chunkText = currentChunk
      .map((e) => `[${e.timestamp}] ${e.name}: ${e.text}`)
      .join('\n');
    const speakers = [...new Set(currentChunk.map((e) => e.name))];

    chunks.push({
      id: `${transcript.episode_name.replace(/[^a-zA-Z0-9]/g, '_')}_${chunkIndex}`,
      text: chunkText,
      episodeTitle: transcript.episode_name,
      speakers,
      startTimestamp: currentChunk[0].timestamp,
      endTimestamp: currentChunk[currentChunk.length - 1].timestamp,
    });
  }

  return chunks;
}

// ============================================
// Personal-aside sub-chunking
// ============================================

const HOST_NAMES_LOWER = [
  'matt haitch', 'jason goldman', 'jason', 'haitch',
  'matt', 'haitch matt', 'mattie',
];

function isHostSpeaker(name: string): boolean {
  const lower = name.toLowerCase().trim();
  return HOST_NAMES_LOWER.some((h) => lower.includes(h));
}

interface AsideCategory {
  name: string;
  preferenceMarkers: RegExp[];
  topicNouns: RegExp[];
  minPreferenceMarkers: number;
  minTopicNouns: number;
}

const ASIDE_CATEGORIES: AsideCategory[] = [
  {
    name: 'food-preference',
    preferenceMarkers: [
      // Food-specific preference language (avoid generic "i love", "my favorite")
      /the answer is/i, /really delicious/i, /comfort food/i,
      /i would .{0,20}(eat|have|get|order)/i, /guilty pleasure/i,
      /i('m| am) hungry/i, /food focused/i,
      /late night snack/i, /looking for is/i,
      /favorite (food|snack|meal|dish|restaurant)/i,
    ],
    topicNouns: [
      // Specific food items unlikely to appear in movie discussion
      /velveeta/i, /shells and cheese/i, /burrito/i, /bbq/i,
      /barbecue/i, /bagel/i, /\blox\b/i, /babka/i, /rice pudding/i,
      /salt lick/i, /\bsnack/i, /fried chicken/i,
      /ramen/i, /sushi/i, /mac and cheese/i, /ice cream/i,
      /cozy shack/i, /prepared food/i, /pickle/i,
      /brisket/i, /chihuahua/i,
      // The word "food(s)" itself is a strong signal
      /\bfoods?\b/i,
    ],
    minPreferenceMarkers: 1,
    minTopicNouns: 2,
  },
];

const ASIDE_WINDOW_SIZE = 15;
const ASIDE_MAX_TOKENS = 400;
const ASIDE_CHUNK_ID_OFFSET = 1000;

function extractPersonalAsides(transcript: Transcript): Chunk[] {
  const dialogues = transcript.dialogues;
  if (!dialogues || dialogues.length < 3) return [];

  const asides: Chunk[] = [];
  const coveredRanges: [number, number][] = [];
  let asideIndex = 0;

  for (const category of ASIDE_CATEGORIES) {
    for (let windowStart = 0; windowStart <= dialogues.length - 3; windowStart++) {
      const windowEnd = Math.min(windowStart + ASIDE_WINDOW_SIZE, dialogues.length);
      const window = dialogues.slice(windowStart, windowEnd);

      // Check if window overlaps with an already-extracted aside
      if (coveredRanges.some(([s, e]) => windowStart < e && windowEnd > s)) continue;

      // Check for host speaker
      const hasHost = window.some((d) => isHostSpeaker(d.name));
      if (!hasHost) continue;

      // Count preference markers across window text
      const windowText = window.map((d) => d.text).join(' ');
      let prefCount = 0;
      for (const pat of category.preferenceMarkers) {
        if (pat.test(windowText)) prefCount++;
      }
      if (prefCount < category.minPreferenceMarkers) continue;

      // Count topic nouns
      let nounCount = 0;
      for (const pat of category.topicNouns) {
        if (pat.test(windowText)) nounCount++;
      }
      if (nounCount < category.minTopicNouns) continue;

      // Find the tightest relevant range within the window
      const range = findRelevantRange(window, category, windowStart);
      if (!range) continue;

      const [relStart, relEnd] = range;
      const absStart = windowStart + relStart;
      const absEnd = windowStart + relEnd;

      // Check overlap again with absolute range
      if (coveredRanges.some(([s, e]) => absStart < e && absEnd > s)) continue;

      // Extract dialogue turns with 1-turn context padding
      const padStart = Math.max(0, absStart - 1);
      const padEnd = Math.min(dialogues.length, absEnd + 1);
      const asideDialogues = dialogues.slice(padStart, padEnd);

      // Cap at max tokens
      let text = '';
      const usedDialogues: DialogueEntry[] = [];
      for (const d of asideDialogues) {
        const line = `[${d.timestamp}] ${d.name}: ${d.text}`;
        if (estimateTokens(text + '\n' + line) > ASIDE_MAX_TOKENS && usedDialogues.length > 0) break;
        usedDialogues.push(d);
        text = text ? text + '\n' + line : line;
      }

      if (usedDialogues.length < 2) continue;

      const speakers = [...new Set(usedDialogues.map((d) => d.name))];
      const sanitizedName = transcript.episode_name.replace(/[^a-zA-Z0-9]/g, '_');
      const chunkId = `${sanitizedName}_${ASIDE_CHUNK_ID_OFFSET + asideIndex}`;

      asides.push({
        id: chunkId,
        text,
        episodeTitle: transcript.episode_name,
        speakers,
        startTimestamp: usedDialogues[0].timestamp,
        endTimestamp: usedDialogues[usedDialogues.length - 1].timestamp,
      });

      coveredRanges.push([absStart, absEnd]);
      asideIndex++;
    }
  }

  return asides;
}

function findRelevantRange(
  window: DialogueEntry[],
  category: AsideCategory,
  _windowStart: number,
): [number, number] | null {
  // Score each dialogue turn for relevance
  const scores: number[] = window.map((d) => {
    let score = 0;
    for (const pat of category.preferenceMarkers) {
      if (pat.test(d.text)) score += 2;
    }
    for (const pat of category.topicNouns) {
      if (pat.test(d.text)) score += 1;
    }
    return score;
  });

  // Find first and last relevant turn (score > 0)
  let first = -1;
  let last = -1;
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] > 0) {
      if (first === -1) first = i;
      last = i;
    }
  }

  if (first === -1) return null;

  // Return [first, last+1) as a half-open range
  return [first, last + 1];
}

// ============================================
// Catchphrase sub-chunking
// ============================================

/**
 * Known recurring catchphrases to extract as sub-chunks.
 * Each entry maps a phrase pattern to its canonical form and speaker.
 */
const CATCHPHRASE_PATTERNS: { pattern: RegExp; speaker: string; label: string }[] = [
  { pattern: /you hack/i, speaker: 'Jason Goldman', label: 'you hack' },
];

const CATCHPHRASE_CHUNK_ID_OFFSET = 2000;

// ============================================
// Segment sub-chunking (voicemail segments)
// ============================================

const SEGMENT_CHUNK_ID_OFFSET = 3000;

const SEGMENT_CONFIGS = [
  {
    label: 'Truthsayer / Birria',
    speakerNames: ['birria'],
    semanticPrefix: '[Recurring segment: Truthsayer / Birria voicemail]',
  },
  {
    label: "Kev's Questions",
    speakerNames: ['kev voicemail', 'Kev', 'KEV'],
    semanticPrefix: "[Recurring segment: Kev's Questions voicemail]",
  },
  {
    label: "Corey's Voicemail",
    speakerNames: ['Corey'],
    semanticPrefix: "[Recurring segment: Corey's Voicemail]",
  },
  {
    label: 'Animal Mother',
    speakerNames: ['Animal Mother'],
    semanticPrefix: '[Recurring segment: Animal Mother voicemail]',
  },
  {
    label: 'Mr Java',
    speakerNames: ['Mr Java', 'Mr. Java'],
    semanticPrefix: '[Recurring segment: Mr Java voicemail]',
  },
  {
    label: 'Lizzen',
    speakerNames: ['Lizzen', 'lizzen'],
    semanticPrefix: '[Recurring segment: Lizzen voicemail]',
  },
  {
    label: "Ethan's Voicemail",
    speakerNames: ['Ethan', 'ethan', 'ETHAN'],
    semanticPrefix: "[Recurring segment: Ethan's Voicemail]",
  },
] as const;

/**
 * Extract small sub-chunks around known recurring catchphrases.
 * For each occurrence, creates a 3-turn window (line before, the line, line after)
 * to give embedding context while keeping the chunk focused on the catchphrase usage.
 */
function extractCatchphraseChunks(transcript: Transcript): Chunk[] {
  const dialogues = transcript.dialogues;
  if (!dialogues || dialogues.length === 0) return [];

  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const cp of CATCHPHRASE_PATTERNS) {
    for (let i = 0; i < dialogues.length; i++) {
      if (!cp.pattern.test(dialogues[i].text)) continue;

      // 3-turn window: one before, the line, one after
      const start = Math.max(0, i - 1);
      const end = Math.min(dialogues.length, i + 2);
      const window = dialogues.slice(start, end);

      const dialogueText = window
        .map((d) => `[${d.timestamp}] ${d.name}: ${d.text}`)
        .join('\n');
      // Prefix with semantic context so embedding matches "catchphrase" queries
      const text = `[Recurring catchphrase: "${cp.label}" — ${cp.speaker}]\n${dialogueText}`;

      const speakers = [...new Set(window.map((d) => d.name))];
      const sanitizedName = transcript.episode_name.replace(/[^a-zA-Z0-9]/g, '_');
      const chunkId = `${sanitizedName}_${CATCHPHRASE_CHUNK_ID_OFFSET + chunkIndex}`;

      chunks.push({
        id: chunkId,
        text,
        episodeTitle: transcript.episode_name,
        speakers,
        startTimestamp: window[0].timestamp,
        endTimestamp: window[window.length - 1].timestamp,
      });

      chunkIndex++;
    }
  }

  return chunks;
}

/**
 * Extract sub-chunks for recurring voicemailer segments (truthsayer, kev, corey, etc.).
 * A segment starts when a configured speaker name appears and ends after 5 consecutive
 * non-voicemailer turns. Host turns interleaved with voicemailer turns are included
 * (hosts react/discuss within the segment). Large segments are split at ~600 tokens.
 */
function extractSegmentChunks(transcript: Transcript): Chunk[] {
  const dialogues = transcript.dialogues;
  if (!dialogues || dialogues.length < 3) return [];

  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const config of SEGMENT_CONFIGS) {
    const speakerSet = new Set(config.speakerNames.map(s => s.toLowerCase()));
    let segmentStart: number | null = null;
    let lastVoicemailerTurn = -1;
    const HOST_GAP_THRESHOLD = 5;

    for (let i = 0; i <= dialogues.length; i++) {
      const name = i < dialogues.length ? dialogues[i].name.toLowerCase() : '';
      const isVoicemailer = speakerSet.has(name);

      if (isVoicemailer && segmentStart === null) {
        segmentStart = i;
        lastVoicemailerTurn = i;
      } else if (isVoicemailer) {
        lastVoicemailerTurn = i;
      }

      const gapExceeded = segmentStart !== null && i - lastVoicemailerTurn > HOST_GAP_THRESHOLD;
      const atEnd = i === dialogues.length && segmentStart !== null;

      if (gapExceeded || atEnd) {
        // Include 1 host reaction after last voicemailer turn
        const segEnd = Math.min(lastVoicemailerTurn + 2, dialogues.length);
        const window = dialogues.slice(segmentStart!, segEnd);

        if (window.length >= 2) {
          const dialogueText = window
            .map(d => `[${d.timestamp}] ${d.name}: ${d.text}`)
            .join('\n');
          const text = `${config.semanticPrefix}\n${dialogueText}`;

          if (estimateTokens(text) <= 800 || window.length <= 4) {
            // Small enough for a single chunk
            const speakers = [...new Set(window.map(d => d.name))];
            const sanitizedName = transcript.episode_name.replace(/[^a-zA-Z0-9]/g, '_');
            const chunkId = `${sanitizedName}_${SEGMENT_CHUNK_ID_OFFSET + chunkIndex}`;

            chunks.push({
              id: chunkId,
              text,
              episodeTitle: transcript.episode_name,
              speakers,
              startTimestamp: window[0].timestamp,
              endTimestamp: window[window.length - 1].timestamp,
            });
            chunkIndex++;
          } else {
            // Large segment: split into sub-chunks of ~600 tokens
            let subStart = 0;
            while (subStart < window.length) {
              let subEnd = subStart + 2;
              while (subEnd <= window.length) {
                const candidate = window.slice(subStart, subEnd)
                  .map(d => `[${d.timestamp}] ${d.name}: ${d.text}`)
                  .join('\n');
                if (estimateTokens(config.semanticPrefix + '\n' + candidate) > 600 && subEnd > subStart + 2) break;
                subEnd++;
              }
              subEnd = Math.min(subEnd, window.length);
              const subWindow = window.slice(subStart, subEnd);
              const subDialogueText = subWindow.map(d => `[${d.timestamp}] ${d.name}: ${d.text}`).join('\n');
              const subText = `${config.semanticPrefix}\n${subDialogueText}`;

              const speakers = [...new Set(subWindow.map(d => d.name))];
              const sanitizedName = transcript.episode_name.replace(/[^a-zA-Z0-9]/g, '_');
              const chunkId = `${sanitizedName}_${SEGMENT_CHUNK_ID_OFFSET + chunkIndex}`;

              chunks.push({
                id: chunkId,
                text: subText,
                episodeTitle: transcript.episode_name,
                speakers,
                startTimestamp: subWindow[0].timestamp,
                endTimestamp: subWindow[subWindow.length - 1].timestamp,
              });
              chunkIndex++;
              subStart = subEnd;
            }
          }
        }

        segmentStart = null;
        lastVoicemailerTurn = -1;
      }
    }
  }

  return chunks;
}

// ============================================
// Topic Extraction (LLM-based topic summaries for supplemental vector search)
// ============================================

// ============================================
// Song Mention Extraction (for /pdc-playlist)
// ============================================

const PLAYLIST_CACHE_PATH = './playlist-cache.json';
const PLAYLIST_DATA_PATH = './playlist-data.json';
const PLAYLIST_VERSION = 2;

interface SongMention {
  song: string;
  artist: string;
  context: string;
  quote: string;
  timestamp: string;
}

interface PlaylistCache {
  version: number;
  entries: Record<string, SongMention[]>; // sha256(transcriptText) -> songs
}

interface PlaylistData {
  episodes: Record<string, { episodeNumber: number | null; songs: SongMention[] }>;
}

function loadPlaylistCache(): PlaylistCache {
  if (fs.existsSync(PLAYLIST_CACHE_PATH)) {
    const raw = JSON.parse(fs.readFileSync(PLAYLIST_CACHE_PATH, 'utf-8'));
    if (raw.version === PLAYLIST_VERSION) return raw;
  }
  return { version: PLAYLIST_VERSION, entries: {} };
}

const SONG_EXTRACTION_PROMPT = `You are analyzing a podcast transcript where hosts discuss a film. Extract ONLY songs and artists that are explicitly named by the hosts. Do NOT include:
- Vague references like "that synth track" or "the score"
- Songs that are only implied or hummed
- Background music or score cues unless explicitly named

Return a JSON array of objects with these fields:
- "song": The song title as named
- "artist": The artist or band name
- "context": A brief 5-15 word description of why the HOSTS discussed this song in conversation (e.g. "debating whether the needle drop was too on-the-nose", "Haitch raving about the soundtrack choice"). Focus on what the hosts said about it, NOT what happens in the film scene.
- "quote": A short direct quote (under 100 chars) where the song was named
- "timestamp": The exact timestamp from the [HH:MM:SS] prefix of the dialogue turn where the song was mentioned. Use the timestamp as-is from the transcript, e.g. "0:24:30"

If no songs are explicitly named, return an empty array: []

IMPORTANT: Return ONLY the JSON array, no other text. No markdown fences.

Transcript:
`;

async function extractSongMentions(
  transcripts: { name: string; transcript: Transcript }[]
): Promise<PlaylistData> {
  console.log(`\nExtracting song mentions from ${transcripts.length} transcripts...`);

  const cache = loadPlaylistCache();
  const playlistData: PlaylistData = { episodes: {} };
  const toExtract: { name: string; transcript: Transcript; hash: string }[] = [];
  let cacheHits = 0;

  // Check cache
  for (const { name, transcript } of transcripts) {
    const dialogueText = transcript.dialogues.map(d => `[${d.timestamp}] ${d.name}: ${d.text}`).join('\n');
    const hash = crypto.createHash('sha256').update(dialogueText).digest('hex');

    if (cache.entries[hash] !== undefined) {
      const songs = cache.entries[hash];
      if (songs.length > 0) {
        const baseTitle = getBaseFilmTitle(transcript.episode_name);
        if (!playlistData.episodes[baseTitle]) {
          playlistData.episodes[baseTitle] = {
            episodeNumber: transcript.episode_number ?? null,
            songs: [],
          };
        }
        playlistData.episodes[baseTitle].songs.push(...songs);
      }
      cacheHits++;
    } else {
      toExtract.push({ name, transcript, hash });
    }
  }

  console.log(`  Cache: ${cacheHits} hits, ${toExtract.length} to extract`);

  if (toExtract.length > 0) {
    const anthropic = new Anthropic();
    const songCost = new CostTracker('claude-haiku-4-5-20251001');
    const BATCH_SIZE = 10;
    const CALL_TIMEOUT_MS = 60_000;
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < toExtract.length; i += BATCH_SIZE) {
      const batch = toExtract.slice(i, i + BATCH_SIZE);
      const promises = batch.map(async ({ name, transcript, hash }) => {
        const dialogueText = transcript.dialogues
          .map(d => `[${d.timestamp}] ${d.name}: ${d.text}`)
          .join('\n');

        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const callPromise = anthropic.messages.create({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 2048,
              messages: [{ role: 'user', content: SONG_EXTRACTION_PROMPT + dialogueText }],
            });
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Haiku call timed out')), CALL_TIMEOUT_MS)
            );
            const response = await Promise.race([callPromise, timeoutPromise]);
            songCost.add(response.usage);
            const text = response.content[0].type === 'text' ? response.content[0].text : '[]';

            // Parse JSON response
            const jsonMatch = text.match(/\[[\s\S]*\]/);
            const songs: SongMention[] = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
            return { name, transcript, hash, songs };
          } catch (err) {
            if (attempt < 2) {
              await new Promise(r => setTimeout(r, Math.pow(2, attempt + 1) * 1000));
            } else {
              console.warn(`  Failed to extract songs from ${name}:`, err);
              return { name, transcript, hash, songs: null as SongMention[] | null };
            }
          }
        }
        return { name, transcript, hash, songs: null as SongMention[] | null };
      });

      const batchResults = await Promise.all(promises);
      for (const r of batchResults) {
        if (r.songs !== null) {
          cache.entries[r.hash] = r.songs;
          if (r.songs.length > 0) {
            const baseTitle = getBaseFilmTitle(r.transcript.episode_name);
            if (!playlistData.episodes[baseTitle]) {
              playlistData.episodes[baseTitle] = {
                episodeNumber: r.transcript.episode_number ?? null,
                songs: [],
              };
            }
            playlistData.episodes[baseTitle].songs.push(...r.songs);
          }
          successCount++;
        } else {
          failCount++;
        }
      }

      // Progress + incremental cache save
      if ((i / BATCH_SIZE) % 5 === 0 || i + BATCH_SIZE >= toExtract.length) {
        console.log(`  Progress: ${Math.min(i + BATCH_SIZE, toExtract.length)}/${toExtract.length} (${successCount} ok, ${failCount} failed)`);
        fs.writeFileSync(PLAYLIST_CACHE_PATH, JSON.stringify(cache));
      }
    }

    // Final cache save
    fs.writeFileSync(PLAYLIST_CACHE_PATH, JSON.stringify(cache));
    console.log(`  Song extraction: ${successCount} success, ${failCount} failed, ${cacheHits} cached`);
    console.log('  ' + songCost.summary('song extraction'));
  }

  // Deduplicate songs within each episode
  for (const key of Object.keys(playlistData.episodes)) {
    const ep = playlistData.episodes[key];
    const seen = new Set<string>();
    ep.songs = ep.songs.filter(s => {
      const id = `${s.song.toLowerCase()}|${s.artist.toLowerCase()}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  const totalSongs = Object.values(playlistData.episodes).reduce((sum, ep) => sum + ep.songs.length, 0);
  console.log(`  Total: ${totalSongs} songs across ${Object.keys(playlistData.episodes).length} episodes`);

  return playlistData;
}

/** Strip "Part N" suffix to combine multi-part episodes under base film title */
function getBaseFilmTitle(episodeName: string): string {
  return episodeName.replace(/\s+Part\s+\d+$/i, '').trim();
}

// ============================================
// Topic Extraction
// ============================================

const TOPIC_CACHE_PATH = './topic-cache.json';
const TOPIC_VERSION = 1;

interface TopicCache {
  version: number;
  entries: Record<string, string>; // sha256(chunkText) -> topicSummary
}

function loadTopicCache(): TopicCache {
  if (fs.existsSync(TOPIC_CACHE_PATH)) {
    const raw = JSON.parse(fs.readFileSync(TOPIC_CACHE_PATH, 'utf-8'));
    if (raw.version === TOPIC_VERSION) return raw;
  }
  return { version: TOPIC_VERSION, entries: {} };
}

function chunkContentHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

const TOPIC_EXTRACTION_PROMPT = `Extract a concise topic summary of this podcast transcript excerpt.
List ALL distinct topics discussed, including:
- The main film/show being discussed
- Any personal anecdotes, preferences, or lifestyle mentions by the hosts
- Any tangential topics, digressions, or asides
- Physical descriptions or characteristics mentioned about anyone
- Specific brands, products, or items mentioned
- Opinions, hot takes, or strong reactions

Only include topics that occupy at least 2-3 lines of dialogue. Ignore single passing words.
Format: A single paragraph, 2-4 sentences. Be specific — use names, brands, and details.
Do NOT editorialize or interpret — just describe what's discussed.

Transcript excerpt:
`;

async function extractTopicSummaries(
  chunks: Chunk[],
): Promise<Map<string, string>> {
  // Filter to standard chunks only (skip sub-chunks with offset IDs)
  const standardChunks = chunks.filter(c => {
    const parts = c.id.split('_');
    const lastNum = parseInt(parts[parts.length - 1], 10);
    return !isNaN(lastNum) && lastNum < 1000;
  });

  console.log(`\nExtracting topic summaries for ${standardChunks.length} standard chunks...`);

  const cache = loadTopicCache();
  const results = new Map<string, string>();
  const toExtract: Chunk[] = [];
  let cacheHits = 0;

  // Check cache
  for (const chunk of standardChunks) {
    const hash = chunkContentHash(chunk.text);
    if (cache.entries[hash]) {
      results.set(chunk.id, cache.entries[hash]);
      cacheHits++;
    } else {
      toExtract.push(chunk);
    }
  }

  console.log(`  Cache: ${cacheHits} hits, ${toExtract.length} to extract`);

  if (toExtract.length === 0) return results;

  // Extract in batches of 20 concurrent Haiku calls
  const anthropic = new Anthropic();
  const topicCost = new CostTracker('claude-haiku-4-5-20251001');
  const BATCH_SIZE = 20;
  const CALL_TIMEOUT_MS = 30_000; // 30s per Haiku call
  let successCount = 0;
  let failCount = 0;
  let batchesSinceLastSave = 0;

  for (let i = 0; i < toExtract.length; i += BATCH_SIZE) {
    const batch = toExtract.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (chunk): Promise<{ chunkId: string; text: string; summary: string | null }> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const callPromise = anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 150,
            messages: [{ role: 'user', content: TOPIC_EXTRACTION_PROMPT + chunk.text }],
          });
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Haiku call timed out')), CALL_TIMEOUT_MS)
          );
          const response = await Promise.race([callPromise, timeoutPromise]);
          topicCost.add(response.usage);
          const summary = response.content[0].type === 'text' ? response.content[0].text : '';
          return { chunkId: chunk.id, text: chunk.text, summary };
        } catch (err) {
          if (attempt < 2) {
            await new Promise(r => setTimeout(r, Math.pow(2, attempt + 1) * 1000));
          } else {
            return { chunkId: chunk.id, text: chunk.text, summary: null };
          }
        }
      }
      return { chunkId: chunk.id, text: chunk.text, summary: null };
    });

    const batchResults = await Promise.all(promises);
    for (const r of batchResults) {
      if (r.summary) {
        results.set(r.chunkId, r.summary);
        cache.entries[chunkContentHash(r.text)] = r.summary;
        successCount++;
      } else {
        failCount++;
      }
    }

    batchesSinceLastSave++;

    if ((i / BATCH_SIZE) % 10 === 0) {
      console.log(`  Progress: ${i + batch.length}/${toExtract.length} (${successCount} ok, ${failCount} failed)`);
      // Save cache every 10 batches (200 chunks) for crash recovery
      fs.writeFileSync(TOPIC_CACHE_PATH, JSON.stringify(cache));
      batchesSinceLastSave = 0;
    }
  }

  // Final cache save
  fs.writeFileSync(TOPIC_CACHE_PATH, JSON.stringify(cache));
  console.log(`  Topic extraction: ${successCount} success, ${failCount} failed, ${cacheHits} cached`);
  console.log('  ' + topicCost.summary('topic extraction'));

  // Fail-safe: abort if >5% failure rate
  const failRate = failCount / (successCount + failCount);
  if (failRate > 0.05) {
    console.error(`  WARNING: ${(failRate * 100).toFixed(1)}% failure rate — topic blob will NOT be generated`);
    return new Map(); // Empty map signals to caller to skip topic blob
  }

  return results;
}

async function generateEmbeddings512(texts: string[]): Promise<number[][]> {
  const maxRetries = 5;
  const embeddings: number[][] = [];

  const safeBatch = texts.map((t) => {
    if (t.length > MAX_EMBEDDING_CHARS) return t.slice(0, MAX_EMBEDDING_CHARS);
    return t;
  });

  async function embedBatch(batch: string[], batchLabel: string): Promise<number[][]> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: batch,
          dimensions: 512,
        });
        return response.data.map((d) => d.embedding);
      } catch (err: unknown) {
        const status = err instanceof Error && 'status' in err ? (err as { status: number }).status : 0;
        if (status === 429 && attempt < maxRetries - 1) {
          const backoff = Math.pow(2, attempt + 1) * 1000;
          console.log(`  Rate limited on ${batchLabel}, retrying in ${backoff / 1000}s...`);
          await new Promise((r) => setTimeout(r, backoff));
        } else if (status === 400 && batch.length > 1) {
          const mid = Math.ceil(batch.length / 2);
          console.log(`  Bad request on ${batchLabel} (${batch.length} texts), splitting into halves...`);
          const left = await embedBatch(batch.slice(0, mid), `${batchLabel}a`);
          const right = await embedBatch(batch.slice(mid), `${batchLabel}b`);
          return [...left, ...right];
        } else {
          throw err;
        }
      }
    }
    throw new Error(`Failed after ${maxRetries} retries on ${batchLabel}`);
  }

  const batchSize = 100;
  for (let i = 0; i < safeBatch.length; i += batchSize) {
    const batch = safeBatch.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(safeBatch.length / batchSize);
    console.log(`  Generating 512-dim embeddings for batch ${batchNum}/${totalBatches}...`);

    const batchEmbeddings = await embedBatch(batch, `topic-batch-${batchNum}`);
    embeddings.push(...batchEmbeddings);
  }

  return embeddings;
}

// ============================================

// text-embedding-3-small max input is 8191 tokens (cl100k_base).
// Individual chunks are within per-input limits, but batches of 100 can
// exceed the per-request total token limit. Use MAX_EMBEDDING_CHARS as
// safety net for edge cases.
const MAX_EMBEDDING_CHARS = 30000;

async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const maxRetries = 5;
  const embeddings: number[][] = [];

  // Truncate any texts that might exceed the embedding model's token limit
  let truncatedCount = 0;
  const safeBatch = texts.map((t) => {
    if (t.length > MAX_EMBEDDING_CHARS) {
      truncatedCount++;
      return t.slice(0, MAX_EMBEDDING_CHARS);
    }
    return t;
  });
  if (truncatedCount > 0) {
    console.log(`  Note: truncated ${truncatedCount} texts exceeding ${MAX_EMBEDDING_CHARS} chars for embedding safety.`);
  }

  // Embed a batch of texts with retry and adaptive batch splitting
  async function embedBatch(batch: string[], batchLabel: string): Promise<number[][]> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: batch,
        });
        return response.data.map((d) => d.embedding);
      } catch (err: unknown) {
        const status = err instanceof Error && 'status' in err ? (err as { status: number }).status : 0;
        if (status === 429 && attempt < maxRetries - 1) {
          const backoff = Math.pow(2, attempt + 1) * 1000;
          console.log(`  Rate limited on ${batchLabel}, retrying in ${backoff / 1000}s...`);
          await new Promise((r) => setTimeout(r, backoff));
        } else if (status === 400 && batch.length > 1) {
          // Split batch in half and retry each half
          const mid = Math.ceil(batch.length / 2);
          console.log(`  Bad request on ${batchLabel} (${batch.length} texts), splitting into halves...`);
          const left = await embedBatch(batch.slice(0, mid), `${batchLabel}a`);
          const right = await embedBatch(batch.slice(mid), `${batchLabel}b`);
          return [...left, ...right];
        } else {
          throw err;
        }
      }
    }
    throw new Error(`Failed after ${maxRetries} retries on ${batchLabel}`);
  }

  const batchSize = 100;
  for (let i = 0; i < safeBatch.length; i += batchSize) {
    const batch = safeBatch.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(safeBatch.length / batchSize);
    console.log(`  Generating embeddings for batch ${batchNum}/${totalBatches}...`);

    const batchEmbeddings = await embedBatch(batch, `batch-${batchNum}`);
    embeddings.push(...batchEmbeddings);
  }

  return embeddings;
}

async function loadBlobTranscripts(): Promise<{ name: string; transcript: Transcript }[]> {
  const results: { name: string; transcript: Transcript }[] = [];

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.log('BLOB_READ_WRITE_TOKEN not set, skipping Blob storage');
    return results;
  }

  try {
    const blobs = await list({ prefix: 'transcripts/' });

    for (const blob of blobs.blobs) {
      if (blob.pathname.endsWith('.json')) {
        try {
          const response = await fetch(blob.url);
          if (response.ok) {
            const transcript: Transcript = await response.json();
            results.push({
              name: blob.pathname.replace('transcripts/', ''),
              transcript,
            });
          }
        } catch (err) {
          console.warn(`  Warning: Could not load ${blob.pathname}:`, err);
        }
      }
    }
  } catch (err) {
    console.warn('Warning: Could not access Blob storage:', err);
  }

  return results;
}

function hashObject(payload: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function getLocalTranscriptFingerprint(): { hash: string; count: number } {
  if (!fs.existsSync(TRANSCRIPTS_DIR)) {
    return { hash: hashObject([]), count: 0 };
  }

  const entries = fs.readdirSync(TRANSCRIPTS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const filePath = path.join(TRANSCRIPTS_DIR, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      return {
        file,
        size: Buffer.byteLength(content, 'utf-8'),
        contentHash: hashObject(content),
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file));

  return { hash: hashObject(entries), count: entries.length };
}

async function getBlobTranscriptFingerprint(): Promise<{ hash: string; count: number }> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return { hash: hashObject([]), count: 0 };
  }

  try {
    const blobs = await list({ prefix: 'transcripts/' });
    const entries = blobs.blobs
      .filter((blob) => blob.pathname.endsWith('.json'))
      .map((blob) => ({
        pathname: blob.pathname,
        size: blob.size,
        uploadedAt: blob.uploadedAt,
      }))
      .sort((a, b) => a.pathname.localeCompare(b.pathname));

    return { hash: hashObject(entries), count: entries.length };
  } catch (err) {
    console.warn('Warning: Could not list transcript blobs for fingerprinting:', err);
    return { hash: hashObject([]), count: 0 };
  }
}

async function loadRemoteManifest(): Promise<{ hash: string } | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return null;
  }

  try {
    const blobs = await list({ prefix: MANIFEST_PATH });
    const match = blobs.blobs.find((b) => b.pathname === MANIFEST_PATH);
    if (!match) {
      return null;
    }
    const response = await fetch(match.url);
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (err) {
    console.warn('Warning: Could not load ingest manifest from Blob:', err);
    return null;
  }
}

async function saveRemoteManifest(payload: {
  hash: string;
  localCount: number;
  blobCount: number;
  updatedAt: string;
}): Promise<void> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.log('BLOB_READ_WRITE_TOKEN not set, skipping manifest upload');
    return;
  }

  await put(MANIFEST_PATH, JSON.stringify(payload), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

async function main() {
  console.log('Starting transcript ingestion...\n');

  if (SKIP_IF_NO_NEW) {
    const localFingerprint = getLocalTranscriptFingerprint();
    const blobFingerprint = await getBlobTranscriptFingerprint();
    const combinedHash = hashObject({
      local: localFingerprint.hash,
      blob: blobFingerprint.hash,
    });
    const manifest = await loadRemoteManifest();

    if (manifest?.hash === combinedHash) {
      console.log('No transcript changes detected. Skipping embeddings.');
      return;
    }
  }

  const allChunks: Chunk[] = [];
  const seenEpisodes = new Set<string>();

  // Load from filesystem first
  if (fs.existsSync(TRANSCRIPTS_DIR)) {
    const files = fs.readdirSync(TRANSCRIPTS_DIR).filter((f) => f.endsWith('.json'));
    console.log(`Found ${files.length} transcript file(s) in filesystem.\n`);

    for (const file of files) {
      const filePath = path.join(TRANSCRIPTS_DIR, file);
      console.log(`Processing: ${file}`);

      const content = fs.readFileSync(filePath, 'utf-8');
      const transcript: Transcript = JSON.parse(content);

      seenEpisodes.add(transcript.episode_name);

      const chunks = chunkTranscript(transcript);
      const asides = extractPersonalAsides(transcript);
      const catchphrases = extractCatchphraseChunks(transcript);
      const segments = extractSegmentChunks(transcript);
      allChunks.push(...chunks, ...asides, ...catchphrases, ...segments);
      const suppCount = asides.length + catchphrases.length + segments.length;
      const subMsg = suppCount > 0
        ? ` + ${asides.length} aside(s) + ${catchphrases.length} catchphrase(s) + ${segments.length} segment(s)` : '';
      console.log(`  Created ${chunks.length} chunks${subMsg} from ${transcript.dialogues?.length || 0} dialogue entries.`);
    }
  } else {
    console.log(`${TRANSCRIPTS_DIR} directory not found, will try Blob storage.\n`);
  }

  // Load from Blob storage (for transcripts not in filesystem)
  console.log('\nChecking Blob storage for additional transcripts...');
  const blobTranscripts = await loadBlobTranscripts();

  let blobCount = 0;
  for (const { name, transcript } of blobTranscripts) {
    // Skip if we already have this episode from filesystem
    if (seenEpisodes.has(transcript.episode_name)) {
      console.log(`  Skipping ${name} (already loaded from filesystem)`);
      continue;
    }

    console.log(`Processing from Blob: ${name}`);
    const chunks = chunkTranscript(transcript);
    const asides = extractPersonalAsides(transcript);
    const catchphrases = extractCatchphraseChunks(transcript);
    const segments = extractSegmentChunks(transcript);
    allChunks.push(...chunks, ...asides, ...catchphrases, ...segments);
    const suppCount = asides.length + catchphrases.length + segments.length;
    const subMsg = suppCount > 0
      ? ` + ${asides.length} aside(s) + ${catchphrases.length} catchphrase(s) + ${segments.length} segment(s)` : '';
    console.log(`  Created ${chunks.length} chunks${subMsg} from ${transcript.dialogues?.length || 0} dialogue entries.`);
    blobCount++;
  }

  if (blobCount > 0) {
    console.log(`\nLoaded ${blobCount} additional transcript(s) from Blob storage.`);
  } else {
    console.log('No additional transcripts found in Blob storage.');
  }

  if (allChunks.length === 0) {
    console.error('\nNo transcripts found in filesystem or Blob storage.');
    process.exit(1);
  }

  console.log(`\nTotal chunks to index: ${allChunks.length}`);

  console.log('\nGenerating embeddings...');
  const embeddings = await generateEmbeddings(allChunks.map((c) => c.text));

  console.log('\nSaving vector store...');
  const storedChunks: StoredChunk[] = allChunks.map((chunk, i) => ({
    id: chunk.id,
    text: chunk.text,
    embedding: embeddings[i],
    metadata: {
      episodeTitle: chunk.episodeTitle,
      speakers: chunk.speakers.join(', '),
      startTimestamp: chunk.startTimestamp,
      endTimestamp: chunk.endTimestamp,
    },
  }));

  fs.writeFileSync(STORE_PATH, JSON.stringify({ chunks: storedChunks }));

  // Build BM25 index for lexical search
  console.log('\nBuilding BM25 lexical index...');
  const bm25Documents: BM25Document[] = storedChunks.map((chunk) => ({
    id: chunk.id,
    text: chunk.text,
    metadata: chunk.metadata,
  }));

  const bm25Index = buildBM25Index(bm25Documents);
  fs.writeFileSync(BM25_STORE_PATH, JSON.stringify(bm25Index));

  console.log(`  BM25 index: ${Object.keys(bm25Index.invertedIndex).length} unique terms`);
  console.log(`  BM25 index saved to ${BM25_STORE_PATH}`);

  // Generate topic summaries and 512-dim embeddings
  if (!process.argv.includes('--skip-topics')) {
    const topicSummaries = await extractTopicSummaries(allChunks);

    if (topicSummaries.size > 0) {
      const topicEntries = Array.from(topicSummaries.entries());
      const topicTexts = topicEntries.map(([, summary]) => summary);
      console.log(`\nGenerating 512-dim embeddings for ${topicTexts.length} topic summaries...`);
      const topicEmbeddings = await generateEmbeddings512(topicTexts);

      const topicChunks = topicEntries.map(([chunkId, summary], i) => {
        const parentChunk = storedChunks.find(c => c.id === chunkId);
        return {
          id: `${chunkId}_topic`,
          text: summary,
          embedding: topicEmbeddings[i],
          parentChunkId: chunkId,
          topicVersion: TOPIC_VERSION,
          metadata: parentChunk?.metadata ?? { episodeTitle: '', speakers: '', startTimestamp: '', endTimestamp: '' },
        };
      });

      const topicBlobPath = path.join(process.cwd(), 'topic-vectors.json');
      fs.writeFileSync(topicBlobPath, JSON.stringify({ chunks: topicChunks }));
      console.log(`Topic vectors saved to ${topicBlobPath} (${topicChunks.length} entries)`);
    }
  } else {
    console.log('\nSkipping topic extraction (--skip-topics flag)');
  }

  // Extract song mentions for playlist feature
  if (!process.argv.includes('--skip-playlist')) {
    const allTranscripts: { name: string; transcript: Transcript }[] = [];

    // Collect all transcripts (filesystem + blob)
    if (fs.existsSync(TRANSCRIPTS_DIR)) {
      const files = fs.readdirSync(TRANSCRIPTS_DIR).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const filePath = path.join(TRANSCRIPTS_DIR, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const transcript: Transcript = JSON.parse(content);
        allTranscripts.push({ name: file, transcript });
      }
    }
    const blobTs = await loadBlobTranscripts();
    const seenNames = new Set(allTranscripts.map(t => t.transcript.episode_name));
    for (const bt of blobTs) {
      if (!seenNames.has(bt.transcript.episode_name)) {
        allTranscripts.push(bt);
      }
    }

    const playlistData = await extractSongMentions(allTranscripts);
    fs.writeFileSync(PLAYLIST_DATA_PATH, JSON.stringify(playlistData, null, 2));
    console.log(`Playlist data saved to ${PLAYLIST_DATA_PATH}`);
  } else {
    console.log('\nSkipping playlist extraction (--skip-playlist flag)');
  }

  console.log('\n✓ Ingestion complete!');
  console.log(`  Indexed ${allChunks.length} chunks from ${seenEpisodes.size} transcript(s).`);
  console.log(`  Vector store saved to ${STORE_PATH}`);
  console.log(`  BM25 index saved to ${BM25_STORE_PATH}`);

  if (SKIP_IF_NO_NEW) {
    const localFingerprint = getLocalTranscriptFingerprint();
    const blobFingerprint = await getBlobTranscriptFingerprint();
    const combinedHash = hashObject({
      local: localFingerprint.hash,
      blob: blobFingerprint.hash,
    });
    await saveRemoteManifest({
      hash: combinedHash,
      localCount: localFingerprint.count,
      blobCount: blobFingerprint.count,
      updatedAt: new Date().toISOString(),
    });
    console.log('Updated ingest manifest in Blob storage.');
  }
}

async function dryRunAsides() {
  console.log('Dry-run: scanning transcripts for personal asides...\n');

  let totalAsides = 0;
  const allResults: { episode: string; asides: Chunk[] }[] = [];

  if (fs.existsSync(TRANSCRIPTS_DIR)) {
    const files = fs.readdirSync(TRANSCRIPTS_DIR).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(TRANSCRIPTS_DIR, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const transcript: Transcript = JSON.parse(content);
      const asides = extractPersonalAsides(transcript);
      if (asides.length > 0) {
        allResults.push({ episode: transcript.episode_name, asides });
        totalAsides += asides.length;
      }
    }
  }

  console.log(`Found ${totalAsides} aside(s) across ${allResults.length} episode(s):\n`);
  for (const { episode, asides } of allResults) {
    for (const aside of asides) {
      console.log(`  [${episode}] ${aside.id}`);
      console.log(`    Timestamps: ${aside.startTimestamp} - ${aside.endTimestamp}`);
      console.log(`    Speakers: ${aside.speakers.join(', ')}`);
      console.log(`    Tokens: ~${estimateTokens(aside.text)}`);
      console.log(`    Preview: ${aside.text.substring(0, 150).replace(/\n/g, ' ')}...`);
      console.log();
    }
  }
}

async function dryRunSegments() {
  console.log('Dry-run: scanning transcripts for voicemailer segments...\n');

  let totalSegments = 0;
  const allResults: { episode: string; segments: Chunk[] }[] = [];

  if (fs.existsSync(TRANSCRIPTS_DIR)) {
    const files = fs.readdirSync(TRANSCRIPTS_DIR).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(TRANSCRIPTS_DIR, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const transcript: Transcript = JSON.parse(content);
      const segments = extractSegmentChunks(transcript);
      if (segments.length > 0) {
        allResults.push({ episode: transcript.episode_name, segments });
        totalSegments += segments.length;
      }
    }
  }

  console.log(`Found ${totalSegments} segment chunk(s) across ${allResults.length} episode(s):\n`);

  // Summary by segment type
  const bySeg: Record<string, number> = {};
  for (const { segments } of allResults) {
    for (const seg of segments) {
      const prefix = seg.text.split('\n')[0];
      bySeg[prefix] = (bySeg[prefix] || 0) + 1;
    }
  }
  console.log('By segment type:');
  for (const [prefix, count] of Object.entries(bySeg)) {
    console.log(`  ${prefix}: ${count}`);
  }
  console.log();

  // Show a few examples
  let shown = 0;
  for (const { episode, segments } of allResults) {
    if (shown >= 10) break;
    for (const seg of segments) {
      if (shown >= 10) break;
      console.log(`  [${episode}] ${seg.id}`);
      console.log(`    Timestamps: ${seg.startTimestamp} - ${seg.endTimestamp}`);
      console.log(`    Speakers: ${seg.speakers.join(', ')}`);
      console.log(`    Tokens: ~${estimateTokens(seg.text)}`);
      console.log(`    Preview: ${seg.text.substring(0, 200).replace(/\n/g, ' ')}...`);
      console.log();
      shown++;
    }
  }
}

async function topicsOnly() {
  console.log('Topics-only mode: extracting topic summaries from existing vector store...\n');

  // Load existing vector store to get chunk data
  if (!fs.existsSync(STORE_PATH)) {
    console.error(`Error: ${STORE_PATH} not found. Run full ingest first.`);
    process.exit(1);
  }

  const storeData = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  const storedChunks: StoredChunk[] = storeData.chunks || [];
  console.log(`Loaded ${storedChunks.length} chunks from ${STORE_PATH}`);

  // Convert StoredChunks back to Chunk format for extractTopicSummaries
  const allChunks: Chunk[] = storedChunks.map(sc => ({
    id: sc.id,
    text: sc.text,
    episodeTitle: sc.metadata.episodeTitle,
    speakers: sc.metadata.speakers.split(', '),
    startTimestamp: sc.metadata.startTimestamp,
    endTimestamp: sc.metadata.endTimestamp,
  }));

  const topicSummaries = await extractTopicSummaries(allChunks);

  if (topicSummaries.size > 0) {
    const topicEntries = Array.from(topicSummaries.entries());
    const topicTexts = topicEntries.map(([, summary]) => summary);
    console.log(`\nGenerating 512-dim embeddings for ${topicTexts.length} topic summaries...`);
    const topicEmbeddings = await generateEmbeddings512(topicTexts);

    const topicChunks = topicEntries.map(([chunkId, summary], i) => {
      const parentChunk = storedChunks.find(c => c.id === chunkId);
      return {
        id: `${chunkId}_topic`,
        text: summary,
        embedding: topicEmbeddings[i],
        parentChunkId: chunkId,
        topicVersion: TOPIC_VERSION,
        metadata: parentChunk?.metadata ?? { episodeTitle: '', speakers: '', startTimestamp: '', endTimestamp: '' },
      };
    });

    const topicBlobPath = path.join(process.cwd(), 'topic-vectors.json');
    fs.writeFileSync(topicBlobPath, JSON.stringify({ chunks: topicChunks }));
    console.log(`\n✓ Topic vectors saved to ${topicBlobPath} (${topicChunks.length} entries)`);
  } else {
    console.log('\nNo topic summaries generated (check failure rate above).');
  }
}

async function playlistOnly() {
  console.log('Playlist-only mode: extracting song mentions from transcripts...\n');

  const allTranscripts: { name: string; transcript: Transcript }[] = [];

  if (fs.existsSync(TRANSCRIPTS_DIR)) {
    const files = fs.readdirSync(TRANSCRIPTS_DIR).filter((f) => f.endsWith('.json'));
    console.log(`Found ${files.length} transcript file(s) in filesystem.`);
    for (const file of files) {
      const filePath = path.join(TRANSCRIPTS_DIR, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const transcript: Transcript = JSON.parse(content);
      allTranscripts.push({ name: file, transcript });
    }
  }

  const blobTs = await loadBlobTranscripts();
  const seenNames = new Set(allTranscripts.map(t => t.transcript.episode_name));
  for (const bt of blobTs) {
    if (!seenNames.has(bt.transcript.episode_name)) {
      allTranscripts.push(bt);
    }
  }

  console.log(`Total: ${allTranscripts.length} transcripts to process.`);

  const playlistData = await extractSongMentions(allTranscripts);
  fs.writeFileSync(PLAYLIST_DATA_PATH, JSON.stringify(playlistData, null, 2));
  console.log(`\n✓ Playlist data saved to ${PLAYLIST_DATA_PATH}`);
}

function getEpisodeArg(): number | null {
  const idx = process.argv.indexOf('--episode');
  if (idx === -1) return null;
  const raw = (process.argv[idx + 1] || '').replace(/^episode_/, '');
  if (!raw || isNaN(Number(raw))) {
    console.error('Usage: --episode <number>  (e.g. --episode 299)');
    process.exit(1);
  }
  return Number(raw);
}

async function singleEpisodeIngest(episodeNum: number) {
  const fileName = `episode_${episodeNum}.json`;
  const filePath = path.join(TRANSCRIPTS_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    console.error(`Transcript not found: ${filePath}`);
    process.exit(1);
  }

  if (!fs.existsSync(STORE_PATH) || !fs.existsSync(BM25_STORE_PATH)) {
    console.error(`Existing vector-store.json and bm25-index.json required. Run full ingest first.`);
    process.exit(1);
  }

  // Load transcript
  const transcript: Transcript = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const epTitle = transcript.episode_name;
  console.log(`Single-episode ingest: ${epTitle} (episode ${episodeNum})\n`);

  // Chunk the episode
  const newChunks = chunkTranscript(transcript);
  const asides = extractPersonalAsides(transcript);
  const catchphrases = extractCatchphraseChunks(transcript);
  const segments = extractSegmentChunks(transcript);
  const allNewChunks = [...newChunks, ...asides, ...catchphrases, ...segments];
  const suppCount = asides.length + catchphrases.length + segments.length;
  const subMsg = suppCount > 0
    ? ` + ${asides.length} aside(s) + ${catchphrases.length} catchphrase(s) + ${segments.length} segment(s)` : '';
  console.log(`Created ${newChunks.length} chunks${subMsg} from ${transcript.dialogues?.length || 0} dialogue entries.`);

  // Load existing stores
  console.log('\nLoading existing vector store...');
  const storeData = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  const existingChunks: StoredChunk[] = storeData.chunks || [];
  const oldCount = existingChunks.length;

  // Remove old chunks for this episode (match by episodeTitle in metadata)
  const kept = existingChunks.filter(c => c.metadata.episodeTitle !== epTitle);
  const removed = oldCount - kept.length;
  console.log(`Removed ${removed} existing chunk(s) for "${epTitle}".`);

  // Generate embeddings for new chunks only
  console.log(`\nGenerating embeddings for ${allNewChunks.length} new chunk(s)...`);
  const embeddings = await generateEmbeddings(allNewChunks.map(c => c.text));

  const newStoredChunks: StoredChunk[] = allNewChunks.map((chunk, i) => ({
    id: chunk.id,
    text: chunk.text,
    embedding: embeddings[i],
    metadata: {
      episodeTitle: chunk.episodeTitle,
      speakers: chunk.speakers.join(', '),
      startTimestamp: chunk.startTimestamp,
      endTimestamp: chunk.endTimestamp,
    },
  }));

  // Merge
  const merged = [...kept, ...newStoredChunks];
  console.log(`\nMerged: ${kept.length} existing + ${newStoredChunks.length} new = ${merged.length} total chunks.`);

  // Save vector store
  fs.writeFileSync(STORE_PATH, JSON.stringify({ chunks: merged }));
  console.log(`Vector store saved to ${STORE_PATH}`);

  // Rebuild BM25 from all docs
  console.log('\nRebuilding BM25 index...');
  const bm25Documents: BM25Document[] = merged.map(chunk => ({
    id: chunk.id,
    text: chunk.text,
    metadata: chunk.metadata,
  }));
  const bm25Index = buildBM25Index(bm25Documents);
  fs.writeFileSync(BM25_STORE_PATH, JSON.stringify(bm25Index));
  console.log(`BM25 index saved (${Object.keys(bm25Index.invertedIndex).length} unique terms).`);

  // Update topic vectors if they exist
  if (!process.argv.includes('--skip-topics')) {
    const topicPath = path.join(process.cwd(), 'topic-vectors.json');
    if (fs.existsSync(topicPath)) {
      console.log('\nUpdating topic vectors...');
      const topicData = JSON.parse(fs.readFileSync(topicPath, 'utf-8'));
      const existingTopics = (topicData.chunks || []).filter(
        (t: { metadata: { episodeTitle: string } }) => t.metadata.episodeTitle !== epTitle
      );

      // Generate topics for new standard chunks only (not asides/catchphrases/segments)
      const topicSummaries = await extractTopicSummaries(newChunks);
      if (topicSummaries.size > 0) {
        const topicEntries = Array.from(topicSummaries.entries());
        const topicTexts = topicEntries.map(([, summary]) => summary);
        console.log(`Generating 512-dim embeddings for ${topicTexts.length} topic summaries...`);
        const topicEmbeddings = await generateEmbeddings512(topicTexts);

        const newTopicChunks = topicEntries.map(([chunkId, summary], i) => {
          const parentChunk = newStoredChunks.find(c => c.id === chunkId);
          return {
            id: `${chunkId}_topic`,
            text: summary,
            embedding: topicEmbeddings[i],
            parentChunkId: chunkId,
            topicVersion: TOPIC_VERSION,
            metadata: parentChunk?.metadata ?? { episodeTitle: '', speakers: '', startTimestamp: '', endTimestamp: '' },
          };
        });

        const mergedTopics = [...existingTopics, ...newTopicChunks];
        fs.writeFileSync(topicPath, JSON.stringify({ chunks: mergedTopics }));
        console.log(`Topic vectors updated: ${mergedTopics.length} total (${newTopicChunks.length} new).`);
      }
    }
  }

  console.log(`\n✓ Single-episode ingest complete for "${epTitle}".`);
}

const episodeArg = getEpisodeArg();

if (process.argv.includes('--dry-run-asides')) {
  dryRunAsides().catch(console.error);
} else if (process.argv.includes('--dry-run-segments')) {
  dryRunSegments().catch(console.error);
} else if (process.argv.includes('--topics-only')) {
  topicsOnly().catch(console.error);
} else if (process.argv.includes('--playlist-only')) {
  playlistOnly().catch(console.error);
} else if (episodeArg !== null) {
  singleEpisodeIngest(episodeArg).catch(console.error);
} else {
  main().catch(console.error);
}
