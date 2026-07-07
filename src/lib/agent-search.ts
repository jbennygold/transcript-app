import Anthropic from '@anthropic-ai/sdk';
import { getAnthropic, HOST_IDENTITY_RULE } from './claude';
import { queryEpisodes, loadEpisodeMetadata } from './metadata-store';
import { listBlobTranscripts, loadTranscriptByUrl } from './blob-storage';
import { TranscriptSource, EpisodeMetadata } from '@/types/episode-metadata';
import { Transcript, DialogueEntry } from '@/types/transcript';
import {
  AGENT_SEARCH_MODEL,
  AGENT_MAX_ITERATIONS,
  AGENT_TIMEOUT_MS,
  AGENT_MAX_TOOL_ERRORS,
  AGENT_WEAK_EVIDENCE_THRESHOLD,
} from './routing-policy';
import { formatEpisodeLabel } from './episode-format';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AgentSearchResult {
  answer: string;
  sources: TranscriptSource[];
  iterationCount: number;
  toolCallCount: number;
  fallbackReason: 'timeout' | 'error_threshold' | 'weak_evidence' | null;
}

export type AgentProgressCallback = (message: string) => void;

interface GrepMatch {
  episodeNumber: number;
  episodeName: string;
  speaker: string;
  timestamp: string;
  text: string;
  contextBefore: string | null;
  contextAfter: string | null;
}

// ─── Transcript Loading ────────────────────────────────────────────────────

let transcriptCache: Map<number, Transcript> | null = null;
let cacheLoadPromise: Promise<Map<number, Transcript>> | null = null;

async function loadAllTranscripts(): Promise<Map<number, Transcript>> {
  if (transcriptCache) return transcriptCache;
  if (cacheLoadPromise) return cacheLoadPromise;

  cacheLoadPromise = (async () => {
    const cache = new Map<number, Transcript>();
    try {
      const blobList = await listBlobTranscripts();
      const results = await Promise.all(
        blobList.map(async (blob) => {
          try {
            // Fetch the URL listBlobTranscripts already resolved — avoids a
            // redundant per-episode list() call (~300 API round-trips) and
            // lets the response be cached instead of re-downloaded every time.
            const transcript = await loadTranscriptByUrl(blob.url);
            return transcript;
          } catch {
            return null;
          }
        })
      );
      for (const transcript of results) {
        if (transcript) {
          cache.set(transcript.episode_number, transcript);
        }
      }
    } catch (err) {
      console.error('Failed to load transcripts from blob storage:', err);
    }
    transcriptCache = cache;
    return cache;
  })();

  return cacheLoadPromise;
}

async function getTranscript(episodeNumber: number): Promise<Transcript | null> {
  const transcripts = await loadAllTranscripts();
  return transcripts.get(episodeNumber) ?? null;
}

// ─── Tool Implementations ──────────────────────────────────────────────────

async function grepTranscripts(
  pattern: string,
  speakerFilter?: string,
  maxResults?: number,
): Promise<GrepMatch[]> {
  const transcripts = await loadAllTranscripts();
  const matches: GrepMatch[] = [];
  const max = maxResults ?? 50;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'i');
  } catch {
    return []; // invalid regex — return empty rather than error
  }

  for (const [, transcript] of transcripts) {
    const dialogues = transcript.dialogues;
    for (let i = 0; i < dialogues.length; i++) {
      if (matches.length >= max) break;

      const d = dialogues[i];

      // Speaker filter
      if (speakerFilter && !d.name.toLowerCase().includes(speakerFilter.toLowerCase())) {
        continue;
      }

      if (regex.test(d.text)) {
        matches.push({
          episodeNumber: transcript.episode_number,
          episodeName: transcript.episode_name,
          speaker: d.name,
          timestamp: d.timestamp,
          text: d.text,
          contextBefore: i > 0 ? `[${dialogues[i - 1].name} @ ${dialogues[i - 1].timestamp}]: ${dialogues[i - 1].text}` : null,
          contextAfter: i < dialogues.length - 1 ? `[${dialogues[i + 1].name} @ ${dialogues[i + 1].timestamp}]: ${dialogues[i + 1].text}` : null,
        });
      }
    }
    if (matches.length >= max) break;
  }

  return matches;
}

async function readEpisodeTranscript(episodeNumber: number): Promise<string | null> {
  const transcript = await getTranscript(episodeNumber);
  if (!transcript) return null;

  return transcript.dialogues
    .map((d: DialogueEntry) => `[${d.timestamp}] ${d.name}: ${d.text}`)
    .join('\n');
}

function searchEpisodes(filters: Record<string, string>): EpisodeMetadata[] {
  const queryFilters: Record<string, unknown> = {};
  if (filters.film) queryFilters.film = filters.film;
  if (filters.guest) queryFilters.guest = filters.guest;
  if (filters.director) queryFilters.director = filters.director;
  if (filters.reviewer) queryFilters.reviewer = filters.reviewer;
  if (filters.genre) queryFilters.genre = filters.genre;
  if (filters.actor) queryFilters.actor = filters.actor;
  if (filters.decade) queryFilters.decade = parseInt(filters.decade, 10);
  if (filters.season) queryFilters.season = parseInt(filters.season, 10);

  const result = queryEpisodes(queryFilters as Parameters<typeof queryEpisodes>[0], {
    limit: 20,
    sortBy: 'episode',
    sortOrder: 'desc',
  });
  return result.episodes;
}

function listEpisodes(limitNum?: number, offsetNum?: number): { number: number; name: string; film: string }[] {
  const all = loadEpisodeMetadata();
  const start = offsetNum ?? 0;
  const count = limitNum ?? 50;
  return all.slice(start, start + count).map(ep => ({
    number: typeof ep.episode === 'number' ? ep.episode : 0,
    name: ep.film,
    film: ep.film,
  }));
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'grep_transcripts',
    description: 'Search across all 300 podcast transcripts using a regex pattern. Returns matching dialogue lines with speaker, timestamp, episode info, and +-1 line of context. Use word boundaries (\\b) for exact matches. Start with targeted patterns before broadening.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'JavaScript regex pattern to search for (case-insensitive). Example: "\\byou hack\\b" for exact phrase match.',
        },
        speaker_filter: {
          type: 'string',
          description: 'Optional: only return matches from this speaker (partial match, case-insensitive). Example: "Jason" or "Haitch".',
        },
        max_results: {
          type: 'number',
          description: 'Maximum results to return (default: 50, max: 200).',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'read_episode_transcript',
    description: 'Read the full transcript of a single episode. Returns all dialogue lines with timestamps and speaker names. Use this when you need full context of a specific episode. Warning: transcripts are large (~20K+ tokens).',
    input_schema: {
      type: 'object' as const,
      properties: {
        episode_number: {
          type: 'number',
          description: 'The episode number to read (1-300).',
        },
      },
      required: ['episode_number'],
    },
  },
  {
    name: 'search_episodes',
    description: 'Search episode metadata (film title, guest, director, reviewer, genre, decade, season). Returns structured episode info. Use this to find which episodes cover a particular film or have a specific guest.',
    input_schema: {
      type: 'object' as const,
      properties: {
        film: { type: 'string', description: 'Film title to search for (partial match).' },
        guest: { type: 'string', description: 'Guest name to search for.' },
        director: { type: 'string', description: 'Director name to search for.' },
        reviewer: { type: 'string', description: 'Reviewer name to search for.' },
        genre: { type: 'string', description: 'Genre to filter by.' },
        actor: { type: 'string', description: 'Actor name to search for.' },
        decade: { type: 'string', description: 'Decade to filter by (e.g., "1980").' },
        season: { type: 'string', description: 'Season number to filter by.' },
      },
      required: [],
    },
  },
  {
    name: 'list_episodes',
    description: 'List all episodes with their numbers and film titles. Use for browsing or getting an overview of the podcast catalog.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max episodes to return (default: 50).' },
        offset: { type: 'number', description: 'Skip first N episodes (default: 0).' },
      },
      required: [],
    },
  },
];

// ─── Tool Execution ────────────────────────────────────────────────────────

async function executeToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<{ result: string; sources: TranscriptSource[] }> {
  const sources: TranscriptSource[] = [];

  switch (toolName) {
    case 'grep_transcripts': {
      const matches = await grepTranscripts(
        toolInput.pattern as string,
        toolInput.speaker_filter as string | undefined,
        Math.min((toolInput.max_results as number) ?? 50, 200),
      );

      for (const m of matches) {
        sources.push({
          episodeTitle: m.episodeName,
          episodeNumber: m.episodeNumber,
          speakers: m.speaker,
          startTimestamp: m.timestamp,
          endTimestamp: m.timestamp,
          text: m.text,
          score: 1.0,
        });
      }

      if (matches.length === 0) {
        return { result: 'No matches found.', sources };
      }

      const formatted = matches.map((m, i) =>
        `[${i + 1}] Episode ${m.episodeNumber} "${m.episodeName}" — ${m.speaker} @ ${m.timestamp}:\n${m.text}${m.contextBefore ? `\n  (before: ${m.contextBefore})` : ''}${m.contextAfter ? `\n  (after: ${m.contextAfter})` : ''}`
      ).join('\n\n');

      return { result: `Found ${matches.length} matches:\n\n${formatted}`, sources };
    }

    case 'read_episode_transcript': {
      const epNum = toolInput.episode_number as number;
      const text = await readEpisodeTranscript(epNum);
      if (!text) {
        return { result: `Episode ${epNum} not found.`, sources: [] };
      }
      return { result: text, sources: [] };
    }

    case 'search_episodes': {
      const episodes = searchEpisodes(toolInput as Record<string, string>);
      if (episodes.length === 0) {
        return { result: 'No matching episodes found.', sources: [] };
      }
      const formatted = episodes.map(ep => {
        const label = formatEpisodeLabel(ep.season, ep.episode);
        const parts = [`${label} — "${ep.film}"`];
        if (ep.guest) parts.push(`Guest: ${ep.guest}`);
        if (ep.reviewer) parts.push(`Reviewer: ${ep.reviewer}`);
        if (ep.directors?.length) parts.push(`Director(s): ${ep.directors.join(', ')}`);
        return parts.join(' | ');
      }).join('\n');
      return { result: `Found ${episodes.length} episodes:\n${formatted}`, sources: [] };
    }

    case 'list_episodes': {
      const eps = listEpisodes(
        toolInput.limit as number | undefined,
        toolInput.offset as number | undefined,
      );
      const formatted = eps.map(ep => `Episode ${ep.number}: "${ep.film}"`).join('\n');
      return { result: formatted, sources: [] };
    }

    default:
      return { result: `Unknown tool: ${toolName}`, sources: [] };
  }
}

// ─── Agent System Prompt ───────────────────────────────────────────────────

const AGENT_SYSTEM_PROMPT = `You are a search agent for the Escape Hatch podcast — a film discussion podcast with ~300 episodes. You have tools to search across all episode transcripts and metadata.

${HOST_IDENTITY_RULE}

SEARCH STRATEGY:
- Start with targeted grep patterns. Use word boundaries (\\b) for exact phrase matching.
- If initial results are sparse, try synonyms and alternative phrasings.
- For "show me the bit/part/moment" queries: the user wants the FULL transcript passage, not a summary. First identify the episode (use search_episodes or grep), then use read_episode_transcript to get the full transcript and find the relevant section. Quote the transcript passage extensively — include the full riff/exchange, not just the key line.
- For catchphrase/recurring queries: a catchphrase is a DISTINCTIVE, UNUSUAL phrase unique to a person — not generic conversational filler like "I love that", "big time", or "that's great" which anyone might say. Search for the actual phrases, not meta-keywords like "catchphrase". Try MANY different candidate phrases (at least 5-10 grep searches for different short phrases) and compare which ones recur across the most DIFFERENT episodes. The best catchphrase candidates are short (2-4 words), quirky or unusual, and appear across many separate episodes. Prioritize cross-episode spread over raw frequency in a single episode.
- For frequency/counting questions: count occurrences systematically across episodes.
- For cultural references: use your world knowledge to infer what the reference might mean, then search for supporting evidence.

GROUNDING RULES:
- Only report what you find in the transcripts. Never fabricate quotes or episodes.
- Use world knowledge to CONNECT references (e.g., infer "the Mark" → Mark Borchardt from American Movie) but only claim the connection if transcript evidence supports it.
- Attribute speech to the correct speaker. "Matt Haitch" and "Haitch" are the same person (use "Haitch"). Never confuse hosts with guests.

ANSWER FORMAT:
- Write your answer directly for the user. Never include internal reasoning, planning, or meta-commentary (e.g., "Let me organize this", "Now I have all the data", "Perfect!"). Start with the answer content immediately.
- Use Markdown with ## headings, **bold**, and bullet points.
- Cite specific episodes, speakers, and timestamps.
- For counting queries, provide the count and list the specific instances.
- For transcript excerpt requests, quote the passage verbatim with timestamps and speaker names. Include the full exchange — the setup, the riff, and the reactions.
- Be thorough but concise — show key evidence, don't dump raw search results.`;

// ─── Agent Loop ────────────────────────────────────────────────────────────

export async function runAgentSearch(
  query: string,
  onProgress?: AgentProgressCallback,
): Promise<AgentSearchResult> {
  const client = getAnthropic();
  const collectedSources = new Map<string, TranscriptSource>();
  let iterationCount = 0;
  let toolCallCount = 0;
  let toolErrorCount = 0;
  let fallbackReason: AgentSearchResult['fallbackReason'] = null;
  const startTime = Date.now();

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: query },
  ];

  for (let i = 0; i < AGENT_MAX_ITERATIONS; i++) {
    // Check timeout
    if (Date.now() - startTime > AGENT_TIMEOUT_MS) {
      fallbackReason = 'timeout';
      break;
    }

    // Check tool error threshold
    if (toolErrorCount > AGENT_MAX_TOOL_ERRORS) {
      fallbackReason = 'error_threshold';
      break;
    }

    iterationCount++;

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: AGENT_SEARCH_MODEL,
        max_tokens: 4096,
        system: AGENT_SYSTEM_PROMPT,
        tools: AGENT_TOOLS,
        messages,
      });
    } catch (err) {
      console.error('Agent model error:', err);
      fallbackReason = 'error_threshold';
      break;
    }

    // If the model is done (no more tool calls), extract the answer
    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === 'text'
      );
      const answer = textBlock?.text ?? 'Unable to generate a response.';
      const sources = Array.from(collectedSources.values());

      // Check weak evidence
      if (sources.length < AGENT_WEAK_EVIDENCE_THRESHOLD) {
        fallbackReason = 'weak_evidence';
      }

      return {
        answer: fallbackReason === 'weak_evidence'
          ? answer + '\n\n---\n*Based on limited evidence found in the transcripts.*'
          : answer,
        sources,
        iterationCount,
        toolCallCount,
        fallbackReason,
      };
    }

    // Process tool calls
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );

    if (toolUseBlocks.length === 0) {
      // Model stopped without tool calls or end_turn — extract text and finish
      const textBlock = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === 'text'
      );
      return {
        answer: textBlock?.text ?? 'Unable to generate a response.',
        sources: Array.from(collectedSources.values()),
        iterationCount,
        toolCallCount,
        fallbackReason,
      };
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      toolCallCount++;
      onProgress?.(`Using ${toolUse.name}...`);

      try {
        const { result, sources } = await executeToolCall(
          toolUse.name,
          toolUse.input as Record<string, unknown>,
        );

        // Deduplicate and collect sources
        for (const source of sources) {
          const key = `${source.episodeTitle}_${source.startTimestamp}`;
          if (!collectedSources.has(key)) {
            collectedSources.set(key, source);
          }
        }

        // Truncate very long results to avoid blowing up context
        const truncated = result.length > 15000
          ? result.slice(0, 15000) + `\n\n[... truncated, ${result.length - 15000} chars omitted. Use more specific patterns or speaker_filter to narrow results.]`
          : result;

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: truncated,
        });
      } catch (err) {
        toolErrorCount++;
        console.error(`Agent tool error (${toolUse.name}):`, err);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Error executing ${toolUse.name}: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
  }

  // Max iterations reached or fallback triggered — force final answer
  if (!fallbackReason) {
    // Max iterations was the reason
    onProgress?.('Finalizing answer...');
  }

  messages.push({
    role: 'user',
    content: 'You have reached the search limit. Please provide your best answer based on what you have found so far.',
  });

  try {
    const finalResponse = await client.messages.create({
      model: AGENT_SEARCH_MODEL,
      max_tokens: 4096,
      system: AGENT_SYSTEM_PROMPT,
      messages,
    });

    const textBlock = finalResponse.content.find(
      (b): b is Anthropic.TextBlock => b.type === 'text'
    );

    const sources = Array.from(collectedSources.values());
    if (sources.length < AGENT_WEAK_EVIDENCE_THRESHOLD && !fallbackReason) {
      fallbackReason = 'weak_evidence';
    }

    const answer = textBlock?.text ?? 'Unable to generate a response.';
    return {
      answer: fallbackReason === 'weak_evidence'
        ? answer + '\n\n---\n*Based on limited evidence found in the transcripts.*'
        : answer,
      sources,
      iterationCount,
      toolCallCount,
      fallbackReason,
    };
  } catch (err) {
    console.error('Agent final synthesis error:', err);
    return {
      answer: '',
      sources: Array.from(collectedSources.values()),
      iterationCount,
      toolCallCount,
      fallbackReason: fallbackReason ?? 'error_threshold',
    };
  }
}
