import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { Transcript } from '@/types/transcript';
import { findEpisodesByFilm, loadEpisodeMetadata } from '@/lib/metadata-store';
import { loadTranscript as loadBlobTranscript } from '@/lib/blob-storage';
import {
  formatTranscriptForPrompt,
  parseTriviaCandidates,
  pickVerifiedTrivia,
  pickRandomFilm,
  displaySpeaker,
  stripMattFromHaitch,
} from '@/lib/trivia';

export type TriviaResponse = {
  film: string;
  episodeNumber: number | null;
  episodeName: string | null;
  pod: string | null;
  /** Speaker and timestamp of the transcript turn the fact came from (transcript source only). */
  speaker: string | null;
  timestamp: string | null;
  /** Short verbatim quote backing the fact (transcript source only). */
  quote: string | null;
  fact: string;
  source: 'transcript' | 'generated';
};

const MODEL = 'claude-haiku-4-5-20251001';

async function loadTranscript(epNum: number): Promise<Transcript | null> {
  try {
    return await loadBlobTranscript(epNum);
  } catch {
    return null;
  }
}

async function fetchTmdbContext(film: string): Promise<string | null> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return null;
  try {
    const params = new URLSearchParams({ api_key: apiKey, query: film });
    const res = await fetch(`https://api.themoviedb.org/3/search/movie?${params}`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results?: { title?: string; release_date?: string; overview?: string }[];
    };
    const hit = data.results?.[0];
    if (!hit) return null;
    const year = hit.release_date?.slice(0, 4);
    const parts = [hit.title && year ? `${hit.title} (${year})` : hit.title, hit.overview].filter(Boolean);
    return parts.length ? parts.join('\n') : null;
  } catch {
    return null;
  }
}

function textOf(message: Anthropic.Message): string {
  const block = message.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') throw new Error('No text in Claude response');
  return block.text.trim();
}

/**
 * Ask the model for several trivia candidates drawn from the episode, each
 * citing a turn index and a verbatim quote. Only quotes that really appear in
 * the cited turn survive (see pickVerifiedTrivia), so a hallucinated fact fails
 * closed and we fall through to the general path.
 */
async function triviaFromTranscript(client: Anthropic, film: string, transcript: Transcript) {
  const numbered = formatTranscriptForPrompt(transcript);

  const prompt = `Below is a transcript of an episode of the Escape Hatch Podcast discussing the film "${film}". Each turn is numbered like [12] Speaker: text.

Find up to 5 distinct trivia-worthy facts the hosts or guest state ABOUT THE FILM. Haitch does most of the talking, so look hardest for facts stated by the guest, Jason, or Corey and include at least two from them if the transcript has any; facts from Haitch are fine as a fallback. Facts can cover: its production, casting, budget, box office, awards, source material, director, behind-the-scenes stories, release history, or a specific claim about how it was made. Prefer surprising, concrete facts over opinions. Skip jokes, personal anecdotes unrelated to the film, and anything about the podcast itself.

For each fact return:
- "fact": one or two sentences, written as a standalone trivia fact in your own words, naming the film. Attribute the claim to the speaker if it is an opinion-ish claim (e.g. "According to Jason, ...").
- Naming rule: the host labelled "Matt Haitch" is always referred to as simply "Haitch" — never "Matt Haitch", never "Matt".
- "turn": the integer turn number the fact comes from.
- "quote": a short verbatim excerpt (5-20 words) copied EXACTLY from that turn's text that supports the fact.

Respond with ONLY a JSON array of objects with keys fact, turn, quote. If there are no suitable facts, respond with [].

TRANSCRIPT:
${numbered}`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const candidates = parseTriviaCandidates(textOf(message));
  return pickVerifiedTrivia(candidates, transcript);
}

async function generateGeneralTrivia(client: Anthropic, film: string): Promise<string> {
  const context = await fetchTmdbContext(film);
  const contextSection = context ? `\nFilm reference (for identification):\n${context}\n` : '';

  const prompt = `Give ONE interesting, widely documented piece of trivia about the film "${film}".
${contextSection}
Rules:
- One or two sentences, plain prose, no markdown, no preamble
- Stick to well-known, verifiable facts (casting, production, source material, release, awards, legacy)
- Do not invent precise figures or dates you are not confident about; prefer qualitative facts over exact numbers
- If you are not confident you know this film, say so in one sentence instead of guessing

Output only the trivia text.`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 200,
    temperature: 1,
    messages: [{ role: 'user', content: prompt }],
  });

  return textOf(message).replace(/^["']|["']$/g, '');
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  // No film given: surprise the caller with a random covered episode.
  const film = searchParams.get('film')?.trim() || pickRandomFilm(loadEpisodeMetadata()) || '';

  if (!film) {
    return NextResponse.json({ error: 'No film given and no episodes available' }, { status: 500 });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const matchedEpisodes = findEpisodesByFilm(film);

  // Transcript path: newest matching episode with a loadable transcript and a verifiable fact.
  for (const episode of matchedEpisodes) {
    const epNum = typeof episode.episode === 'number' ? episode.episode : null;
    if (epNum === null) continue;

    const transcript = await loadTranscript(epNum);
    if (!transcript) continue;

    try {
      // Haiku occasionally paraphrases every quote so nothing verifies; one retry
      // (a fresh sample) recovers most of those before we fall back to general trivia.
      const trivia =
        (await triviaFromTranscript(client, episode.film, transcript)) ??
        (await triviaFromTranscript(client, episode.film, transcript));
      if (trivia) {
        return NextResponse.json({
          film: episode.film,
          episodeNumber: epNum,
          episodeName: transcript.episode_name,
          pod: episode.pod,
          speaker: displaySpeaker(trivia.speaker),
          timestamp: trivia.timestamp,
          quote: trivia.quote,
          fact: stripMattFromHaitch(trivia.fact),
          source: 'transcript',
        } satisfies TriviaResponse);
      }
    } catch (error) {
      console.error(`Transcript trivia failed for episode ${epNum}:`, error);
    }
  }

  // General path: film never covered, or nothing verifiable in the transcript.
  const matchedEpisode = matchedEpisodes[0] ?? null;
  const epNum =
    matchedEpisode && typeof matchedEpisode.episode === 'number' ? matchedEpisode.episode : null;

  let fact: string;
  try {
    fact = await generateGeneralTrivia(client, matchedEpisode?.film ?? film);
  } catch (error) {
    console.error('Failed to generate trivia:', error);
    return NextResponse.json({ error: 'Failed to generate trivia' }, { status: 500 });
  }

  return NextResponse.json({
    film: matchedEpisode?.film ?? film,
    episodeNumber: epNum,
    episodeName: matchedEpisode?.film ?? null,
    pod: matchedEpisode?.pod ?? null,
    speaker: null,
    timestamp: null,
    quote: null,
    fact: stripMattFromHaitch(fact),
    source: 'generated',
  } satisfies TriviaResponse);
}
