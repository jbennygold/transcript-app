import Anthropic from '@anthropic-ai/sdk';
import { TranscriptChunk } from '@/types/transcript';
import {
  EpisodeMetadata,
  ClassificationResult,
} from '@/types/episode-metadata';
import { formatEpisodeDescriptor } from './episode-format';
import { DEEP_SYNTHESIS_MODEL } from './routing-policy';

/**
 * Normalize speaker names before they reach synthesis prompts.
 * "Matt Haitch" / "Haitch Matt" → "Haitch" so the LLM never sees the confusing full label.
 */
function normalizeSpeakers(speakers: string[]): string[] {
  return speakers.map((s) => {
    const lower = s.toLowerCase().trim();
    if (lower === 'matt haitch' || lower === 'haitch matt') return 'Haitch';
    return s;
  });
}

export const HOST_IDENTITY_RULE = `HOST IDENTITY RULE (MANDATORY):
- The Escape Hatch podcast has exactly TWO hosts: "Haitch" and "Jason". Every episode features both of them.
- "Matt", "Matt Haitch", and "Haitch" are ALL the same person — use "Haitch" only.
- All other named speakers (e.g., Proto, Slim, Corey, Kev, Jonesy, Rosie, birria, Hex, Nexus9, Truthsayer, etc.) are guests, featured reviewers, or voicemailers — NEVER refer to them as hosts.
- When the user says "the hosts", they mean Haitch and Jason exclusively.`;

let anthropicClient: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxRetries: 4,
    });
  }
  return anthropicClient;
}

export async function answerQuestion(
  question: string,
  chunks: TranscriptChunk[]
): Promise<string> {
  const context = chunks
    .map((chunk, i) => {
      return `--- Excerpt ${i + 1} ---
Episode: ${chunk.episodeTitle}
Speakers: ${normalizeSpeakers(chunk.speakers).join(', ')}
Timestamp: ${chunk.startTimestamp} - ${chunk.endTimestamp}
---
${chunk.text}
---`;
    })
    .join('\n\n');

  const message = await getAnthropic().messages.create({
    model: DEEP_SYNTHESIS_MODEL,
    max_tokens: 2048,  // Increased from 1024 for longer interpretive answers
    messages: [
      {
        role: 'user',
        content: `You are a helpful assistant that answers questions about the Escape Hatch podcast. Based on the following podcast excerpts, answer the question thoughtfully.

${HOST_IDENTITY_RULE}

Your response style should match the question:
- For interpretive questions (e.g., "What do they think about X?", "How do they feel about Y?"): Provide an expansive, analytical answer that synthesizes the hosts' perspectives, themes, and opinions. Use references with timestamps to illustrate and support your interpretation, but don't just list quotes.
- For specific questions (e.g., "What did Jason say about X?", "When did they mention Y?"): Provide direct quotes with episode names, speakers, and timestamps.

If the excerpts don't contain relevant information, say so clearly.

PODCAST EXCERPTS:
${context}

QUESTION: ${question}

Provide a thoughtful answer based on the excerpts above.`,
      },
    ],
  });

  const textBlock = message.content.find((block) => block.type === 'text');
  return textBlock ? textBlock.text : 'Unable to generate a response.';
}

function formatTranscriptContext(chunks: TranscriptChunk[]): string {
  if (chunks.length === 0) return '';

  return chunks
    .map((chunk, i) => {
      return `--- Excerpt ${i + 1} ---
Episode: ${chunk.episodeTitle}
Speakers: ${normalizeSpeakers(chunk.speakers).join(', ')}
Timestamp: ${chunk.startTimestamp} - ${chunk.endTimestamp}
---
${chunk.text}
---`;
    })
    .join('\n\n');
}

function formatMetadataContext(episodes: EpisodeMetadata[]): string {
  if (episodes.length === 0) return '';

  return episodes
    .map((ep, i) => {
      const parts = [
        `[Episode ${i + 1}]`,
        `Film: ${ep.film}`,
        formatEpisodeDescriptor(ep.season, ep.episode),
        `Release Date: ${ep.releaseDate}`,
        `Length: ${ep.length}`,
        `Reviewer: ${ep.reviewer}`,
      ];

      if (ep.guest) {
        parts.push(`Guest: ${ep.guest}`);
      }

      if (ep.notableMoments) {
        parts.push(`Notable Moments: ${ep.notableMoments}`);
      }

      if (ep.mmmCount > 0) {
        parts.push(`MMM Count: ${ep.mmmCount}`);
      }

      if (ep.thatsGreatCount > 0) {
        parts.push(`"That's Great" Count: ${ep.thatsGreatCount}`);
      }

      return parts.join('\n');
    })
    .join('\n\n');
}

function computeCountSummary(
  question: string,
  episodes: EpisodeMetadata[],
  metadataContext?: MetadataContext
): string | null {
  if (metadataContext?.hasMore) {
    return null;
  }

  const normalized = question.toLowerCase();
  const wantsCount = /(how many|what .*movies|which .*movies|what .*films|which .*films|what .*episodes|which .*episodes)/.test(normalized);
  if (!wantsCount) {
    return null;
  }

  const uniqueFilms = new Set(episodes.map((ep) => ep.film)).size;
  const episodeCount = episodes.length;
  return `COUNT_SUMMARY: ${uniqueFilms} films across ${episodeCount} episodes.`;
}

export async function synthesizeHybridAnswer(
  question: string,
  classification: ClassificationResult,
  transcriptChunks: TranscriptChunk[],
  metadataEpisodes: EpisodeMetadata[],
  metadataContext?: MetadataContext,
  tuning?: { model?: string; maxTokens?: number }
): Promise<string> {
  const hasTranscripts = transcriptChunks.length > 0;
  const hasMetadata = metadataEpisodes.length > 0;

  if (!hasTranscripts && !hasMetadata) {
    return 'No matching episodes found in the database.\n\n**Note:** The episode database can filter by: film title, decade (e.g., "80s movies"), season number, guest name, reviewer, director, cinematographer, actor, or genre.';
  }

  let contextSection = '';
  let sourceDescription = '';
  let truncationNote = '';

  // Add truncation note if results were limited
  if (metadataContext?.hasMore) {
    truncationNote = `\n\nNOTE: Showing ${metadataContext.returnedCount} of ${metadataContext.totalCount} total matching episodes. The response includes the most recent episodes.`;
  }

  const countSummary = classification.type === 'factual' && hasMetadata
    ? computeCountSummary(question, metadataEpisodes, metadataContext)
    : null;

  if (classification.type === 'factual' && hasMetadata && !hasTranscripts) {
    sourceDescription = 'episode metadata (structured data about episodes)';
    const countInfo = metadataContext
      ? ` (${metadataContext.returnedCount}${metadataContext.hasMore ? ` of ${metadataContext.totalCount}` : ''} episodes)`
      : '';
    contextSection = `EPISODE METADATA${countInfo}:
${formatMetadataContext(metadataEpisodes)}${truncationNote}${countSummary ? `\n\n${countSummary}` : ''}`;
  } else if (classification.type === 'factual' && hasMetadata && hasTranscripts) {
    // Factual query with both sources — metadata is primary, transcripts supplement
    sourceDescription = 'episode metadata AND podcast transcripts';
    const countInfo = metadataContext
      ? ` (${metadataContext.returnedCount}${metadataContext.hasMore ? ` of ${metadataContext.totalCount}` : ''} episodes)`
      : '';
    contextSection = `EPISODE METADATA${countInfo}:
${formatMetadataContext(metadataEpisodes)}${truncationNote}${countSummary ? `\n\n${countSummary}` : ''}

---

PODCAST TRANSCRIPTS (${transcriptChunks.length} supplementary excerpts):
${formatTranscriptContext(transcriptChunks)}`;
  } else if (classification.type === 'factual' && !hasMetadata && hasTranscripts) {
    // Factual query fell back to transcripts (no metadata matched)
    sourceDescription = 'podcast transcripts (searched because no structured metadata matched your query)';
    contextSection = `PODCAST TRANSCRIPTS (${transcriptChunks.length} excerpts):
${formatTranscriptContext(transcriptChunks)}

NOTE: No structured episode metadata matched this query. The transcripts above may contain relevant discussion.`;
  } else if (hasTranscripts && !hasMetadata) {
    sourceDescription = 'podcast transcripts (what was actually said)';
    contextSection = `PODCAST TRANSCRIPTS:
${formatTranscriptContext(transcriptChunks)}`;
  } else {
    // Both sources available (hybrid, or interpretive with metadata)
    sourceDescription = 'both episode metadata AND podcast transcripts';
    const parts: string[] = [];

    if (hasMetadata) {
      const countInfo = metadataContext
        ? `${metadataContext.returnedCount}${metadataContext.hasMore ? ` of ${metadataContext.totalCount}` : ''}`
        : String(metadataEpisodes.length);
      parts.push(`EPISODE METADATA (${countInfo} episodes):
${formatMetadataContext(metadataEpisodes)}${truncationNote}`);
    }

    if (hasTranscripts) {
      parts.push(`PODCAST TRANSCRIPTS (${transcriptChunks.length} excerpts):
${formatTranscriptContext(transcriptChunks)}`);
    }

    contextSection = parts.join('\n\n---\n\n');
  }

  const systemPrompt = buildSystemPrompt(classification.type, sourceDescription, Boolean(countSummary));
  const maxTokens = tuning?.maxTokens ?? getAdaptiveMaxTokens(classification.type, metadataEpisodes.length);
  const model = tuning?.model ?? DEEP_SYNTHESIS_MODEL;

  const message = await getAnthropic().messages.create({
    model,
    max_tokens: maxTokens,
    messages: [
      {
        role: 'user',
        content: `${systemPrompt}

${contextSection}

QUESTION: ${question}

Provide a thoughtful answer based on the information above.`,
      },
    ],
  });

  const textBlock = message.content.find((block) => block.type === 'text');
  return textBlock ? textBlock.text : 'Unable to generate a response.';
}

export interface MetadataContext {
  totalCount: number;
  returnedCount: number;
  hasMore: boolean;
}

/**
 * Calculate adaptive max_tokens based on query type and result count.
 * - Factual queries need more tokens to list episodes
 * - More results = more tokens needed
 * - Hybrid queries need room for both metadata and analysis
 */
function getAdaptiveMaxTokens(
  queryType: 'factual' | 'interpretive' | 'hybrid',
  metadataCount: number
): number {
  // Base tokens: interpretive needs room for cross-episode synthesis
  let tokens = queryType === 'interpretive' ? 2048 : 1024;

  // Factual queries need room for episode lists
  if (queryType === 'factual') {
    tokens += 1024;
    // Large result sets need even more
    if (metadataCount > 20) {
      tokens += 1024;
    } else if (metadataCount > 10) {
      tokens += 512;
    }
  }

  // Hybrid queries need both metadata summary and analysis
  if (queryType === 'hybrid') {
    tokens += 512;
    if (metadataCount > 10) {
      tokens += 512;
    }
  }

  // Cap at 4096 to avoid excessive costs
  return Math.min(tokens, 4096);
}

export async function* synthesizeHybridAnswerStreaming(
  question: string,
  classification: ClassificationResult,
  transcriptChunks: TranscriptChunk[],
  metadataEpisodes: EpisodeMetadata[],
  metadataContext?: MetadataContext,
  tuning?: { model?: string; maxTokens?: number }
): AsyncGenerator<{ type: 'chunk' | 'done'; text: string }> {
  const hasTranscripts = transcriptChunks.length > 0;
  const hasMetadata = metadataEpisodes.length > 0;

  if (!hasTranscripts && !hasMetadata) {
    yield { type: 'done', text: 'No matching episodes found in the database.\n\n**Note:** The episode database can filter by: film title, decade (e.g., "80s movies"), season number, guest name, reviewer, director, cinematographer, actor, or genre.' };
    return;
  }

  let contextSection = '';
  let sourceDescription = '';
  let truncationNote = '';

  // Add truncation note if results were limited
  if (metadataContext?.hasMore) {
    truncationNote = `\n\nNOTE: Showing ${metadataContext.returnedCount} of ${metadataContext.totalCount} total matching episodes. The response includes the most recent episodes.`;
  }

  const countSummary = classification.type === 'factual' && hasMetadata
    ? computeCountSummary(question, metadataEpisodes, metadataContext)
    : null;

  if (classification.type === 'factual' && hasMetadata && !hasTranscripts) {
    sourceDescription = 'episode metadata (structured data about episodes)';
    const countInfo = metadataContext
      ? ` (${metadataContext.returnedCount}${metadataContext.hasMore ? ` of ${metadataContext.totalCount}` : ''} episodes)`
      : '';
    contextSection = `EPISODE METADATA${countInfo}:
${formatMetadataContext(metadataEpisodes)}${truncationNote}${countSummary ? `\n\n${countSummary}` : ''}`;
  } else if (classification.type === 'factual' && hasMetadata && hasTranscripts) {
    sourceDescription = 'episode metadata AND podcast transcripts';
    const countInfo = metadataContext
      ? ` (${metadataContext.returnedCount}${metadataContext.hasMore ? ` of ${metadataContext.totalCount}` : ''} episodes)`
      : '';
    contextSection = `EPISODE METADATA${countInfo}:
${formatMetadataContext(metadataEpisodes)}${truncationNote}${countSummary ? `\n\n${countSummary}` : ''}

---

PODCAST TRANSCRIPTS (${transcriptChunks.length} supplementary excerpts):
${formatTranscriptContext(transcriptChunks)}`;
  } else if (classification.type === 'factual' && !hasMetadata && hasTranscripts) {
    sourceDescription = 'podcast transcripts (searched because no structured metadata matched your query)';
    contextSection = `PODCAST TRANSCRIPTS (${transcriptChunks.length} excerpts):
${formatTranscriptContext(transcriptChunks)}

NOTE: No structured episode metadata matched this query. The transcripts above may contain relevant discussion.`;
  } else if (hasTranscripts && !hasMetadata) {
    sourceDescription = 'podcast transcripts (what was actually said)';
    contextSection = `PODCAST TRANSCRIPTS:
${formatTranscriptContext(transcriptChunks)}`;
  } else {
    sourceDescription = 'both episode metadata AND podcast transcripts';
    const parts: string[] = [];

    if (hasMetadata) {
      const countInfo = metadataContext
        ? `${metadataContext.returnedCount}${metadataContext.hasMore ? ` of ${metadataContext.totalCount}` : ''}`
        : String(metadataEpisodes.length);
      parts.push(`EPISODE METADATA (${countInfo} episodes):
${formatMetadataContext(metadataEpisodes)}${truncationNote}`);
    }

    if (hasTranscripts) {
      parts.push(`PODCAST TRANSCRIPTS (${transcriptChunks.length} excerpts):
${formatTranscriptContext(transcriptChunks)}`);
    }

    contextSection = parts.join('\n\n---\n\n');
  }

  const systemPrompt = buildSystemPrompt(classification.type, sourceDescription, Boolean(countSummary));
  const maxTokens = tuning?.maxTokens ?? getAdaptiveMaxTokens(classification.type, metadataEpisodes.length);
  const model = tuning?.model ?? DEEP_SYNTHESIS_MODEL;

  const stream = getAnthropic().messages.stream({
    model,
    max_tokens: maxTokens,
    messages: [
      {
        role: 'user',
        content: `${systemPrompt}

${contextSection}

QUESTION: ${question}

Provide a thoughtful answer based on the information above.`,
      },
    ],
  });

  let fullText = '';

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      fullText += event.delta.text;
      yield { type: 'chunk', text: event.delta.text };
    }
  }

  yield { type: 'done', text: fullText };
}

function buildSystemPrompt(
  queryType: 'factual' | 'interpretive' | 'hybrid',
  sourceDescription: string,
  hasCountSummary: boolean
): string {
  const basePrompt = `You are a helpful assistant that answers questions about the Escape Hatch podcast. You have access to ${sourceDescription}.

${HOST_IDENTITY_RULE}

CRITICAL GROUNDING RULES - YOU MUST FOLLOW THESE:
1. Base your answer on the provided data below. Do NOT invent episodes, films, guests, or quotes that don't appear in the data.
2. NEVER invent, guess, or hallucinate episodes, films, guests, or quotes
3. If the provided data does not contain relevant information, clearly state "I don't have information about [topic] in the provided data"
4. If asked about something not in the data, do NOT make up plausible-sounding answers
5. When listing episodes from METADATA, only list ones that appear in the EPISODE METADATA section
6. When using TRANSCRIPTS, you CAN extract factual information mentioned in the conversation (e.g., if hosts discuss covering a Tim Burton film, you can report that)
7. CROSS-EPISODE SEARCH: When transcript excerpts are provided, CAREFULLY search through ALL of them — every single transcript excerpt, not just the first few — for the specific words, phrases, names, or content the user is asking about. The excerpts come from DIFFERENT episodes and the best content may be in any of them. Only conclude "I don't have information" after verifying the content is not present in ANY excerpt. For "What has X said about Y" queries, scan every excerpt for mentions of Y and report findings from ALL episodes where it appears.
8. PARTIAL EVIDENCE RULE: If the provided excerpts contain information related to ANY part of the user's question, you MUST describe what you found. Never respond with "I don't have information" when relevant content exists in the sources. For multi-part questions, address each part separately — state what you found and what you couldn't find.
9. IMPLICIT KNOWLEDGE BRIDGING: When the user's query describes something by a characteristic (e.g., "directorial debut", "first film", "breakout role") rather than by name, use your general knowledge to connect the description to the provided sources. Do NOT say "no information" when the sources contain the answer under a different name.
   BRIDGING PROCEDURE: (a) Identify descriptive terms in the query that refer to a specific work or person. (b) Check whether any provided source episodes match via your world knowledge. (c) If yes, discuss those sources and name the connection explicitly.
   EXAMPLE — Query: "the Wachowskis' directorial debut" + Sources include Bound episode
   WRONG: "The transcripts do not discuss the Wachowskis' directorial debut."
   RIGHT: "The hosts discussed **Bound** (1996), which was the Wachowskis' feature directorial debut. They noted that..."
   (Bound IS their debut — state the connection, then discuss what the sources say.)
10. MULTI-REFERENT COVERAGE: When a query term has multiple distinct meanings or referents across the provided sources, you MUST address ALL distinct referent clusters. Do not focus on one interpretation and ignore others.
   COVERAGE PROCEDURE: (a) Before answering, scan ALL provided sources and list every distinct meaning/referent of the query term you find. (b) Organize your answer to address each one. (c) Never claim "no information" about a referent type that appears in the sources.
   EXAMPLE — Query: "Mercury" + Sources contain: Freddie Mercury discussion, Mercury spacecraft discussion, Mercury the planet reference
   WRONG: "The hosts discussed Freddie Mercury in episode X..." (ignores spacecraft and planet)
   RIGHT: "The podcast references 'Mercury' in several contexts: 1. **Freddie Mercury** — discussed in [episode]... 2. **Mercury spacecraft** — mentioned in [episode]... 3. **The planet** — briefly referenced in..."
   (Enumerate ALL distinct referents found in the sources.)
11. SPEAKER ATTRIBUTION (MANDATORY): Each line in the transcripts is labeled with a speaker name (e.g., "[55:43] Jason Goldman: ..."). When the user asks what a SPECIFIC person said, you MUST check the speaker label on each quote. Only attribute a statement to someone if their name appears as the speaker on that line. Do NOT attribute quotes from "Jason Goldman" to "Haitch" or vice versa — they are different people.
   When the query asks about "the hosts", "Haitch", or "Jason", prioritize evidence where that speaker is talking. If the other host or a guest said something relevant, include it but attribute it correctly.
   EXAMPLE — Query: "What snobbish things has Haitch said about music?" + Transcripts show "[62:22] Jason Goldman: Let these boomers take their shit with their fucking Bruce Springsteen, Bob Dylan bullshit."
   WRONG: "Haitch dismissed Bob Dylan and Bruce Springsteen as 'bullshit'" (wrong speaker — Jason said this)
   RIGHT: "In this conversation, it was actually **Jason** who dismissed Dylan and Springsteen. Haitch [describe what Haitch actually said, if anything]."
12. PREFERENCE-CONFIDENCE THRESHOLD: For superlative or preference queries (trigger words: "favorite", "favourite", "best", "worst", "most hated", "all-time", "top", "number one"), calibrate your confidence to the strength of the evidence:
   - STRONG evidence (repeated praise, explicit ranking, emphatic language across multiple excerpts) → confident language ("clearly a favorite", "they particularly loved")
   - WEAK evidence (single mention, passing positive comment, or one brief remark) → hedged language ("spoke positively about", "mentioned favorably, though this may not reflect their overall ranking")
   - NO evidence → say so directly; do NOT guess based on general knowledge of the film
   EXAMPLE — Query: "What is Jason's favorite movie they've covered?"
   WRONG: "Jason's favorite movie is Jaws — he spoke very highly of it." (upgrades a single positive mention to "favorite")
   RIGHT: "Jason spoke enthusiastically about **Jaws**, calling it '...' He also praised **Arrival** in multiple episodes. Based on the available excerpts, these are among his most-discussed favorites, though the podcast may not have a single definitive ranking."
13. SEGMENT HEADLINES & UNFAMILIAR TITLES: Hosts often introduce a news or trailer segment with a terse headline naming the people and title together (e.g., "Hatch News: Nolan, Matt Damon, The Odyssey"). Treat such a headline as describing ONE topic — typically director, star(s), title — and treat the conversation that follows as a discussion of that title, even if the hosts only refer to it afterward as "the trailer", "it", or "the [director] movie". Commas in transcripts are auto-generated and do NOT mean the names are separate topics.
   Recent or unreleased films may be unknown to you. Your not recognizing a title is NOT evidence that it isn't a film or that the mention is incidental — rely on how the hosts use it in the transcript. State the connection as plain fact; never write "following the rule" or otherwise refer to these instructions.
   EXAMPLE — Query: "mentions of Kestrel, an unreleased movie" + Transcript: "[10:02] Hatch News: Villeneuve, Zendaya, Kestrel. [10:08] The trailer dropped, thoughts? [10:10] I'm nervous about Villeneuve doing comedy..."
   WRONG: "Kestrel is only listed in passing; the hosts pivot to a Villeneuve project instead."
   RIGHT: "The hosts discussed the trailer for **Kestrel** (Villeneuve directing, Zendaya starring) in a Hatch News segment at 10:02. They said..."

IMPORTANT: Format your response using proper Markdown:
- Use ## for section headings (e.g., "## Overview")
- Use **bold** for emphasis and film/episode titles — ALWAYS bold episode titles when citing them (e.g., "in the **Empire Strikes Back** episode")
- Use bullet points for lists
- Use "quotation marks" for inline quotes, NOT > characters
- Only use > for standalone block quotes on their own line
- Do NOT reference internal source labels like "(Excerpt 3)" or "[Transcript 5]" or "(Source 2)" — users cannot see these. Instead cite by **bolded episode name** and timestamp (e.g., "in the **Empire Strikes Back** episode around 45:00").`;

  // Check if we're using transcripts as a fallback for factual queries
  const isTranscriptFallback = sourceDescription.includes('transcript') && queryType === 'factual';

  switch (queryType) {
    case 'factual':
      if (isTranscriptFallback) {
        return `${basePrompt}

This is a FACTUAL query, but no structured metadata matched. Using transcript search instead.
- Extract factual information from the transcript excerpts (e.g., which films were discussed, who was mentioned)
- If the hosts mention covering specific films or directors, report those findings
- Be clear that the information comes from transcript discussion, not structured episode data
- If the transcripts don't contain relevant information, clearly state that`;
      }
      return `${basePrompt}

This is a FACTUAL query about episode metadata. Provide:
- Direct, concise answers with specific counts or lists
- Reference specific episodes by name, season, and episode number
- IMPORTANT: List ALL matching episodes - do not skip any or summarize. If 10 episodes match, list all 10.
- Format lists clearly with bullet points or numbered items
- Use ## headings to organize by year or category if listing many items
- If a COUNT_SUMMARY is provided, use it and do not restate or invent other counts
- Verify your count matches the number of items you listed when you include counts
- If no episodes match the criteria, clearly state that (e.g., "No Tim Burton films appear in the episode data")`;

    case 'interpretive':
      return `${basePrompt}

This is an INTERPRETIVE query about opinions and discussions.

BEFORE writing your answer, you MUST do this mental scan (do not output it):
- Go through EVERY transcript excerpt (1 through N)
- For each one, check: does it contain the person/topic the user asked about?
- Note which excerpts and episodes have relevant content
- Then write your answer using ALL the evidence you found across ALL episodes

Provide:
- Analytical synthesis of what the hosts said and thought
- Include direct quotes with episode names and timestamps
- Capture nuance and different perspectives between hosts
- Don't just list quotes - weave them into a coherent narrative
- Use ## headings to organize themes or topics in your analysis
- IMPORTANT: The excerpts come from MANY different episodes. A person or topic may be discussed in episodes that are NOT about that person/topic. Treat ALL mentions as valid evidence regardless of which episode they appear in.
- If the transcripts don't discuss the topic, clearly state that`;

    case 'hybrid':
      return `${basePrompt}

This is a HYBRID query that requires both metadata filtering AND content analysis. Provide:
- First, identify relevant episodes based on the metadata criteria
- Then, analyze what was said in those specific episodes
- Combine factual information (which episodes, who, when) with interpretive analysis (what they thought, how they felt)
- Reference both episode metadata and specific quotes where helpful
- Use ## headings to organize your response
- If no relevant data is found, clearly state that`;
  }
}
