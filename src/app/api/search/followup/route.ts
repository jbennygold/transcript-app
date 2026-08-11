import { NextRequest } from 'next/server';
import { getAnthropic, HOST_IDENTITY_RULE } from '@/lib/claude';
import { DEEP_SYNTHESIS_MODEL } from '@/lib/routing-policy';
import { startSseHeartbeat } from '@/lib/sse-heartbeat';

interface TranscriptSourceInput {
  episodeTitle: string;
  speakers: string;
  startTimestamp: string;
  endTimestamp: string;
  text: string;
}

interface MetadataSourceInput {
  film: string;
  season: number;
  episode: number;
  releaseDate: string;
  guest: string | null;
  reviewer: string;
  relevantFields?: Record<string, string>;
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { query, followUpQuery, previousAnswer, sources } = body;

  if (!followUpQuery || typeof followUpQuery !== 'string' || !followUpQuery.trim()) {
    return new Response(JSON.stringify({ error: 'Follow-up question is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!previousAnswer || typeof previousAnswer !== 'string') {
    return new Response(JSON.stringify({ error: 'Previous answer is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const transcripts: TranscriptSourceInput[] = sources?.transcripts ?? [];
  const metadata: MetadataSourceInput[] = sources?.metadata ?? [];

  if (transcripts.length === 0 && metadata.length === 0) {
    return new Response(JSON.stringify({ error: 'No sources provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // See stream/route.ts — long silent stretches get the connection reaped
      // on mobile networks, surfacing as "Load failed" on the client.
      const heartbeat = startSseHeartbeat({
        write: (payload) => controller.enqueue(encoder.encode(payload)),
      });

      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
        heartbeat.markActivity();
      };

      try {
        const requestStart = Date.now();

        // Format transcript context
        let contextSection = '';
        if (transcripts.length > 0) {
          const transcriptContext = transcripts
            .map((t, i) => {
              return `[Transcript ${i + 1}]
Episode: ${t.episodeTitle}
Speakers: ${t.speakers}
Timestamp: ${t.startTimestamp} - ${t.endTimestamp}
---
${t.text}
---`;
            })
            .join('\n\n');
          contextSection += `PODCAST TRANSCRIPTS (${transcripts.length} excerpts):\n${transcriptContext}`;
        }

        if (metadata.length > 0) {
          const metadataContext = metadata
            .map((m, i) => {
              const parts = [
                `[Episode ${i + 1}]`,
                `Film: ${m.film}`,
                `Season ${m.season}, Episode ${m.episode}`,
                `Release Date: ${m.releaseDate}`,
                `Reviewer: ${m.reviewer}`,
              ];
              if (m.guest) parts.push(`Guest: ${m.guest}`);
              if (m.relevantFields) {
                for (const [key, value] of Object.entries(m.relevantFields)) {
                  parts.push(`${key}: ${value}`);
                }
              }
              return parts.join('\n');
            })
            .join('\n\n');

          if (contextSection) contextSection += '\n\n---\n\n';
          contextSection += `EPISODE METADATA (${metadata.length} episodes):\n${metadataContext}`;
        }

        const prompt = `You are a helpful assistant answering follow-up questions about the Escape Hatch podcast.

${HOST_IDENTITY_RULE}

The user previously searched for: "${query || ''}"

You gave this answer:
---
${previousAnswer}
---

The answer was based on these podcast sources:

${contextSection}

The user now asks a follow-up question. Answer it using the same sources above.
If the sources don't contain enough information to answer the follow-up, say so.

IMPORTANT: Format your response using proper Markdown:
- Use ## for section headings
- Use **bold** for emphasis and film titles
- Use bullet points for lists
- Use "quotation marks" for inline quotes, NOT > characters

FOLLOW-UP QUESTION: ${followUpQuery.trim()}`;

        const llmStream = getAnthropic().messages.stream({
          model: DEEP_SYNTHESIS_MODEL,
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }],
        });

        let answer = '';
        for await (const event of llmStream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            answer += event.delta.text;
            send('chunk', { text: event.delta.text });
          }
        }

        const totalMs = Date.now() - requestStart;
        send('complete', {
          answer,
          perf: { totalMs, path: 'followup' },
        });
        controller.close();
      } catch (error) {
        console.error('Follow-up error:', error);
        let errorMessage = 'Unknown error';
        if (error instanceof Error) {
          errorMessage = error.message;
        }
        send('error', { message: `Follow-up failed: ${errorMessage}` });
        controller.close();
      } finally {
        heartbeat.stop();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
