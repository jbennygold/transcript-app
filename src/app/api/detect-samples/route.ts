import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import type { DialogueEntry } from '@/types/transcript';
import { describeLLMError } from '@/lib/llm-error';

const BATCH_SIZE = 120;
const CONTEXT_OVERLAP = 5;

const anthropic = new Anthropic();

function buildPrompt(
  episodeName: string,
  knownSpeakers: string[],
  dialogues: { index: number; name: string; timestamp: string; text: string }[],
): string {
  return `You are analyzing a podcast transcript to identify movie clips, interview samples, and non-podcast audio that was played during the episode. The podcast is called "Escape Hatch" and reviews one film per episode.

Episode: ${episodeName}
Known podcast speakers: ${knownSpeakers.join(', ')}

These dialogue turns were transcribed by automated speaker diarization, which often misattributes movie clips and interview samples to one of the podcast speakers. Your job is to identify which turns are NOT actually spoken by the podcast participants — they are audio from a movie, interview, trailer, TV clip, or other external source played during the podcast.

Key signals:
- Hosts often say things like "play the clip", "drop in the sample", "here's the bit" right BEFORE a sample
- Movie/interview samples have content that doesn't match the podcast conversation flow
- Samples may feature actors, directors, or characters being discussed
- Samples often have a different tone, vocabulary, or speaking style
- Short reactions between sample lines (like "wow", "ha") may still be the hosts reacting in real-time — only flag the sample itself
- The podcast intro/outro sounder is already labeled "Sounder/FX" — ignore those

Here are the dialogue turns (index | speaker | timestamp | text):
${dialogues.map(d => `${d.index} | ${d.name} | ${d.timestamp} | ${d.text}`).join('\n')}

Return ONLY a JSON array of the indices that are movie/interview samples. If none are found, return an empty array.
Example: [45, 46, 47, 48]

JSON array:`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { dialogues, episodeName } = body as {
      dialogues: DialogueEntry[];
      episodeName: string;
    };

    if (!dialogues?.length || !episodeName) {
      return NextResponse.json(
        { error: 'Missing dialogues or episodeName' },
        { status: 400 },
      );
    }

    // Collect known speakers (non-category, non-placeholder)
    const knownSpeakers = Array.from(
      new Set(
        dialogues
          .map(d => d.name)
          .filter(n => n && !/^(Speaker\s*)?[A-Z]$/i.test(n) && n !== 'Sounder/FX' && n !== 'Movie Sample'),
      ),
    );

    // Process in batches with overlap for context
    const allFlagged = new Set<number>();
    for (let start = 0; start < dialogues.length; start += BATCH_SIZE - CONTEXT_OVERLAP) {
      const end = Math.min(start + BATCH_SIZE, dialogues.length);
      const batch = dialogues.slice(start, end).map((d, i) => ({
        index: start + i,
        name: d.name,
        timestamp: d.timestamp,
        text: d.text,
      }));

      const prompt = buildPrompt(episodeName, knownSpeakers, batch);

      const message = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = message.content[0]?.type === 'text' ? message.content[0].text : '';
      try {
        const match = text.match(/\[[\s\S]*?\]/);
        if (match) {
          const indices = JSON.parse(match[0]) as number[];
          for (const idx of indices) {
            if (typeof idx === 'number' && idx >= 0 && idx < dialogues.length) {
              allFlagged.add(idx);
            }
          }
        }
      } catch {
        console.warn('Failed to parse sample detection response:', text.slice(0, 200));
      }

      // Don't re-process the overlap region
      if (end >= dialogues.length) break;
    }

    return NextResponse.json({
      sampleIndices: Array.from(allFlagged).sort((a, b) => a - b),
      total: dialogues.length,
    });
  } catch (err) {
    console.error('Sample detection error:', err);
    const { message } = describeLLMError(err);
    return NextResponse.json(
      { error: `Sample detection failed: ${message}` },
      { status: 500 },
    );
  }
}
