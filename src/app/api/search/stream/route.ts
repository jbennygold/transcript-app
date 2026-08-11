import { NextRequest } from 'next/server';
import { getEpisodeByNumber, queryEpisodes, searchNotableMoments } from '@/lib/metadata-store';
import { classifyQuery } from '@/lib/query-classifier';
import { detectQueryIntent } from '@/lib/query-intent';
import { buildMetadataAggregateResponse, collectTildaContext, getTildaEpisodePicks } from '@/lib/metadata-aggregates';
import { extractEpisodeNumberFromQuery, extractTildaPickerFromQuery } from '@/lib/tilda-query';
import { extractNotableMomentsFilm } from '@/lib/notable-moments-query';
import { isBM25Loaded } from '@/lib/bm25-loader';
import { getVectorStoreSize, isVectorStoreLoaded } from '@/lib/vectorstore';
import { getSearchTuning } from '@/lib/search-tuning';
import { synthesizeHybridAnswerStreaming, MetadataContext, getAnthropic, HOST_IDENTITY_RULE } from '@/lib/claude';
import { generateEmbedding, generateEmbeddings } from '@/lib/embeddings';
import { hybridRetrieval, isBM25Available, getAdaptiveK } from '@/lib/hybrid-retrieval';
import { rerankChunks } from '@/lib/reranker';
import { logQuery, generateLogId } from '@/lib/query-logger';
import { classifyUseCase } from '@/lib/use-case-classifier';
import { formatEpisodeLabel } from '@/lib/episode-format';
import { TranscriptChunk } from '@/types/transcript';
import {
  MetadataSource,
  TranscriptSource,
  EpisodeMetadata,
} from '@/types/episode-metadata';
import {
  MAX_LIMIT,
  DEFAULT_LIMIT,
  QUICK_SYNTHESIS,
  DEEP_SYNTHESIS_MODEL,
  episodeToMetadataSource,
  shouldSkipMetadataAggregate,
  shouldForceHybridClassification,
  shouldUseQuickSynthesis,
  resolveSearchStrategy,
  recordAgentResult,
  AGENT_SEARCH_MODEL,
} from '@/lib/routing-policy';
import { runAgentSearch } from '@/lib/agent-search';
import { startSseHeartbeat } from '@/lib/sse-heartbeat';

let loggedCacheStatus = false;



export async function POST(request: NextRequest) {
  const body = await request.json();
  const { query, limit: rawLimit, offset: rawOffset, variant, depth: rawDepth } = body;
  const depth: 'quick' | 'deep' = rawDepth === 'deep' ? 'deep' : 'quick';

  if (!query || typeof query !== 'string') {
    return new Response(JSON.stringify({ error: 'Query is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse and validate pagination params
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, typeof rawLimit === 'number' ? rawLimit : DEFAULT_LIMIT)
  );
  const offset = Math.max(0, typeof rawOffset === 'number' ? rawOffset : 0);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Agent search can run ~25s without emitting an event; mobile networks
      // reap connections idle that long and the client sees "Load failed".
      // Heartbeat frames are enqueued whole, so they can only ever land
      // between complete SSE frames, never inside one.
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
        const queryId = generateLogId();
        if (!loggedCacheStatus) {
          loggedCacheStatus = true;
          console.log('Search cache status', {
            vectorStoreLoaded: isVectorStoreLoaded(),
            vectorStoreSize: getVectorStoreSize(),
            bm25Loaded: isBM25Loaded(),
          });
        }

        const allowVariants = process.env.ALLOW_VARIANTS === '1' || process.env.NODE_ENV !== 'production';
        const requestedVariant = typeof variant === 'string' ? variant : undefined;
        let tuning = allowVariants ? getSearchTuning(requestedVariant) : null;
        // Intent detection (pre-classification routing)
        const intent = detectQueryIntent(query);
        let fastPathHandled = false;
        if (intent.type !== 'none') {
          if (intent.type === 'metadata_notable_moments' && depth !== 'deep') {
            const episodeNumber = extractEpisodeNumberFromQuery(query);
            let episodes: EpisodeMetadata[] = [];

            if (episodeNumber !== null) {
              const episode = getEpisodeByNumber(episodeNumber);
              if (episode) episodes = [episode];
            } else {
              const filmQuery = extractNotableMomentsFilm(query);
              if (filmQuery) {
                const notableResult = queryEpisodes({ film: filmQuery }, {
                  limit: 5,
                  offset: 0,
                  sortBy: 'episode',
                  sortOrder: 'asc',
                });
                episodes = notableResult.episodes;
              }
            }

            if (episodes.length === 0) {
              console.log('Notable moments fast-path failed, falling through to full pipeline');
            } else {
              const sections = episodes.map((episode) => {
                const epLabel = formatEpisodeLabel(episode.season, episode.episode);
                const notable = episode.notableMoments?.trim();
                if (!notable) {
                  return `### ${epLabel} — "${episode.film}"\nNo notable moments recorded.`;
                }
                return `### ${epLabel} — "${episode.film}"\n${notable}`;
              });

              const nmAnswer = `Notable Moments\n\n${sections.join('\n\n')}`;
              const nmTotalMs = Date.now() - requestStart;
              send('complete', {
                answer: nmAnswer,
                queryId,
                queryType: 'factual',
                canDeepen: depth === 'quick',
                sources: { metadata: episodes.map(episodeToMetadataSource) },
                metadata: {
                  totalCount: episodes.length,
                  returnedCount: episodes.length,
                  hasMore: false,
                },
                perf: { totalMs: nmTotalMs, path: 'metadata_notable_moments' },
              });
              controller.close();
              logQuery({
                query,
                classification: { type: 'fast_path' },
                sourceCount: episodes.length,
                transcriptSourceCount: 0,
                metadataSourceCount: episodes.length,
                sourceEpisodes: episodes.map((e) => e.film),
                answerLength: nmAnswer.length,
                latencyMs: nmTotalMs,
                path: 'metadata_notable_moments',
                intent: { type: intent.type, confidence: intent.confidence },
                depth,
                routingPath: 'metadata_fast_path',
                useCase: classifyUseCase({
                  query,
                  intentType: intent.type,
                  routingPath: 'metadata_fast_path',
                }),
              }, queryId).catch(() => {});
              fastPathHandled = true;
            }
          }

          // Tilda intent: collect data and synthesize with LLM
          if (intent.type === 'metadata_tilda' && !fastPathHandled) {
            const episodeNumber = extractEpisodeNumberFromQuery(query);
            if (episodeNumber !== null) {
              const episodeResult = getTildaEpisodePicks(episodeNumber);
              if (!episodeResult) {
                console.log(`Tilda episode fast-path failed for ep ${episodeNumber}, falling through to full pipeline`);
              } else {
                const { episode, picks } = episodeResult;
                const epLabel = formatEpisodeLabel(episode.season, episode.episode);
                const picker = extractTildaPickerFromQuery(query);
                let answer: string;

                if (picker) {
                  const match = picks.find((pick) => pick.label === picker);
                  if (match) {
                    answer = `${picker} pick for ${epLabel} — "${episode.film}": ${match.value}.`;
                  } else if (picks.length > 0) {
                    const picksLine = picks.map((pick) => `${pick.label}: ${pick.value}`).join(' · ');
                    answer = `No ${picker} pick recorded for ${epLabel} — "${episode.film}". Other picks: ${picksLine}.`;
                  } else {
                    answer = `No Tilda picks recorded for ${epLabel} — "${episode.film}".`;
                  }
                } else if (picks.length > 0) {
                  const picksLine = picks.map((pick) => `${pick.label}: ${pick.value}`).join(' · ');
                  answer = `Tilda picks for ${epLabel} — "${episode.film}": ${picksLine}.`;
                } else {
                  answer = `No Tilda picks recorded for ${epLabel} — "${episode.film}".`;
                }

                const tildaEpMs = Date.now() - requestStart;
                send('complete', {
                  answer,
                  queryId,
                  queryType: 'factual',
                  sources: { metadata: [episodeToMetadataSource(episode)] },
                  metadata: { totalCount: 1, returnedCount: 1, hasMore: false },
                  perf: { totalMs: tildaEpMs, path: 'metadata_tilda' },
                });
                controller.close();
                logQuery({
                  query,
                  classification: { type: 'fast_path' },
                  sourceCount: 1,
                  transcriptSourceCount: 0,
                  metadataSourceCount: 1,
                  sourceEpisodes: [episode.film],
                  answerLength: answer.length,
                  latencyMs: tildaEpMs,
                  path: 'metadata_tilda',
                  intent: { type: intent.type, confidence: intent.confidence },
                  depth,
                  routingPath: 'metadata_fast_path',
                  useCase: classifyUseCase({
                    query,
                    intentType: intent.type,
                    routingPath: 'metadata_fast_path',
                  }),
                }, queryId).catch(() => {});
                fastPathHandled = true;
              }
            }

            if (!fastPathHandled) {
              const tildaResult = collectTildaContext();
              if (!tildaResult) {
                console.log('Tilda context fast-path failed, falling through to full pipeline');
              } else {
                const normalized = query.toLowerCase();
                const wantsEarliest = /\b(first|earliest|original|start|started|begin|began|debut)\b/.test(normalized);
                if (wantsEarliest && tildaResult.earliestEpisode) {
                  const earliest = tildaResult.earliestEpisode;
                  const epLabel = formatEpisodeLabel(earliest.season, earliest.episode);
                  const picksLine = tildaResult.earliestPicks.length > 0
                    ? `Picks: ${tildaResult.earliestPicks.join(', ')}`
                    : 'No pick details recorded.';

                  const earliestAnswer = `Earliest recorded "Who Would Tilda Swinton Play?" picks: ${epLabel} — "${earliest.film}".\n\n${picksLine}`;
                  const earliestMs = Date.now() - requestStart;
                  send('complete', {
                    answer: earliestAnswer,
                    queryId,
                    queryType: 'factual',
                    sources: { metadata: tildaResult.sources },
                    metadata: {
                      totalCount: tildaResult.episodeCount,
                      returnedCount: tildaResult.sources.length,
                      hasMore: false,
                    },
                    perf: { totalMs: earliestMs, path: 'metadata_tilda' },
                  });
                  controller.close();
                  logQuery({
                    query,
                    classification: { type: 'fast_path' },
                    sourceCount: tildaResult.sources.length,
                    transcriptSourceCount: 0,
                    metadataSourceCount: tildaResult.sources.length,
                    sourceEpisodes: tildaResult.sources.map((s) => s.film),
                    answerLength: earliestAnswer.length,
                    latencyMs: earliestMs,
                    path: 'metadata_tilda',
                    intent: { type: intent.type, confidence: intent.confidence },
                    depth,
                    routingPath: 'metadata_fast_path',
                    useCase: classifyUseCase({
                      query,
                      intentType: intent.type,
                      routingPath: 'metadata_fast_path',
                    }),
                  }, queryId).catch(() => {});
                  fastPathHandled = true;
                } else {
                  send('progress', { stage: 'synthesizing', message: 'Analyzing Tilda picks...' });

                  const tildaModel = depth === 'quick' ? QUICK_SYNTHESIS.model : DEEP_SYNTHESIS_MODEL;
                  const tildaMaxTokens = depth === 'quick' ? QUICK_SYNTHESIS.maxTokens : 2048;
                  const tildaStream = getAnthropic().messages.stream({
                    model: tildaModel,
                    max_tokens: tildaMaxTokens,
                    messages: [{
                      role: 'user',
                      content: `You are a podcast search assistant for the Escape Hatch podcast.

${HOST_IDENTITY_RULE}

${tildaResult.context}

QUESTION: ${query}

Answer based on the Tilda casting data above. Be specific, cite examples from the data. Use Markdown formatting with ## headings, **bold**, and bullet points.`,
                    }],
                  });

                  let answer = '';
                  for await (const event of tildaStream) {
                    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                      answer += event.delta.text;
                      send('chunk', { text: event.delta.text });
                    }
                  }

                  const tildaSynthMs = Date.now() - requestStart;
                  send('complete', {
                    answer,
                    queryId,
                    queryType: 'factual',
                    canDeepen: depth === 'quick',
                    sources: { metadata: tildaResult.sources },
                    metadata: {
                      totalCount: tildaResult.episodeCount,
                      returnedCount: tildaResult.sources.length,
                      hasMore: false,
                    },
                    perf: { totalMs: tildaSynthMs, path: 'metadata_tilda' },
                  });
                  controller.close();
                  logQuery({
                    query,
                    classification: { type: 'fast_path' },
                    sourceCount: tildaResult.sources.length,
                    transcriptSourceCount: 0,
                    metadataSourceCount: tildaResult.sources.length,
                    sourceEpisodes: tildaResult.sources.map((s) => s.film),
                    answerLength: answer.length,
                    latencyMs: tildaSynthMs,
                    path: 'metadata_tilda',
                    intent: { type: intent.type, confidence: intent.confidence },
                    synthesisModel: tildaModel,
                    depth,
                    routingPath: 'metadata_fast_path',
                    useCase: classifyUseCase({
                      query,
                      intentType: intent.type,
                      routingPath: 'metadata_fast_path',
                    }),
                  }, queryId).catch(() => {});
                  fastPathHandled = true;
                }
              }
            }
          }

          if (!fastPathHandled && shouldSkipMetadataAggregate(intent)) {
            console.log('Medium-confidence intent, falling through to full pipeline', { type: intent.type, confidence: intent.confidence });
          }

          if (!fastPathHandled && !shouldSkipMetadataAggregate(intent)) {
            const aggregate = buildMetadataAggregateResponse(intent);
            if (aggregate) {
              const totalMs = Date.now() - requestStart;
              const aggMetaCount = aggregate.sources.metadata?.length || 0;
              send('progress', { stage: 'metadata', message: 'Answering from metadata...' });
              send('complete', {
                answer: aggregate.answer,
                queryId,
                queryType: 'factual',
                sources: aggregate.sources,
                metadata: {
                  totalCount: aggMetaCount,
                  returnedCount: aggMetaCount,
                  hasMore: false,
                },
                perf: {
                  totalMs,
                  path: 'metadata',
                },
              });
              controller.close();
              logQuery({
                query,
                classification: { type: 'fast_path' },
                sourceCount: aggMetaCount,
                transcriptSourceCount: 0,
                metadataSourceCount: aggMetaCount,
                sourceEpisodes: aggregate.sources.metadata?.map((s) => s.film) ?? [],
                answerLength: aggregate.answer.length,
                latencyMs: totalMs,
                path: 'metadata',
                intent: { type: intent.type, confidence: intent.confidence },
                depth,
                routingPath: 'metadata_fast_path',
                useCase: classifyUseCase({
                  query,
                  intentType: intent.type,
                  routingPath: 'metadata_fast_path',
                }),
              }, queryId).catch(() => {});
              fastPathHandled = true;
            }
          }
        }

        if (fastPathHandled) {
          return;
        }

        // Step 1: Classify query + pre-compute embedding in parallel
        send('progress', { stage: 'classifying', message: 'Analyzing your query...' });
        const embeddingPromise = generateEmbedding(query).catch((err) => {
          console.warn('Pre-computed embedding failed:', err);
          return null;
        });
        const [classification, precomputedEmbedding] = await Promise.all([
          classifyQuery(query),
          embeddingPromise,
        ]);
        if (shouldForceHybridClassification(classification)) {
          console.log('Low-confidence classification, forcing hybrid', { original: classification.type, confidence: classification.confidence });
          classification.type = 'hybrid';
        }
        if (classification.type === 'interpretive' && !tuning && depth !== 'deep') {
          tuning = getSearchTuning('fast');
        }
        console.log('Classification result:', JSON.stringify(classification));

        // Generate supplemental embeddings if classifier produced supplemental queries
        let supplementalEmbeddings: number[][] | undefined;
        if (classification.supplementalQueries?.length) {
          try {
            supplementalEmbeddings = await generateEmbeddings(classification.supplementalQueries);
          } catch (err) {
            console.warn('Supplemental embedding generation failed:', err);
          }
        }

        send('progress', {
          stage: 'classified',
          message: `Query type: ${classification.type}`,
          queryType: classification.type,
        });

        // ── Agent Search Branch ──────────────────────────────────────
        const searchStrategy = resolveSearchStrategy(query, classification.searchStrategy, {
          detectedFilm: classification.filters?.film || null,
        });
        if (searchStrategy === 'agent') {
          console.log('Agent search activated for query:', query);
          send('progress', { stage: 'agent_search', message: 'Deep searching...' });
          const agentStart = Date.now();

          try {
            const agentResult = await runAgentSearch(query, (msg) => {
              send('progress', { stage: 'agent_search', message: msg });
            });

            const agentMs = Date.now() - agentStart;
            const totalMs = Date.now() - requestStart;
            const answer = agentResult.answer;
            const transcriptSources: TranscriptSource[] = agentResult.sources;

            recordAgentResult(!agentResult.fallbackReason || agentResult.fallbackReason === 'weak_evidence');

            // Stream the answer
            send('progress', { stage: 'synthesizing', message: 'Composing answer...' });
            for (let ci = 0; ci < answer.length; ci += 20) {
              send('chunk', { text: answer.slice(ci, ci + 20) });
            }

            send('complete', {
              answer,
              queryId,
              queryType: classification.type,
              classificationConfidence: classification.confidence,
              searchStrategy: 'agent',
              sources: {
                transcripts: transcriptSources.length > 0 ? transcriptSources : undefined,
              },
              metadata: { totalCount: 0, returnedCount: 0, hasMore: false },
              perf: { totalMs, path: 'agent_search' },
            });
            controller.close();

            const allSourceEpisodes = [...new Set(transcriptSources.map(s => s.episodeTitle))];
            logQuery({
              query,
              classification: {
                type: classification.type,
                confidence: classification.confidence,
                filters: { ...classification.filters },
              },
              sourceCount: transcriptSources.length,
              transcriptSourceCount: transcriptSources.length,
              metadataSourceCount: 0,
              sourceEpisodes: allSourceEpisodes,
              answerLength: answer.length,
              latencyMs: totalMs,
              path: 'agent_search',
              intent: { type: intent.type, confidence: intent.confidence },
              synthesisModel: AGENT_SEARCH_MODEL,
              depth,
              routingPath: 'agent_search',
              searchStrategy: 'agent',
              agentIterationCount: agentResult.iterationCount,
              agentToolCallCount: agentResult.toolCallCount,
              agentFallbackReason: agentResult.fallbackReason,
              agentLatencyBreakdownMs: {
                route: agentStart - requestStart,
                tooling: agentMs,
                synthesis: 0, // synthesis is inline with agent loop
                total: totalMs,
              },
              useCase: classifyUseCase({
                query,
                classificationType: classification.type,
                filters: { ...classification.filters },
                intentType: intent.type,
                routingPath: 'agent_search',
                searchStrategy: 'agent',
              }),
            }, queryId).catch(() => {});
            return;
          } catch (agentError) {
            console.error('Agent search failed, falling through to RAG:', agentError);
            recordAgentResult(false);
            send('progress', { stage: 'agent_fallback', message: 'Deep search failed, using standard search...' });
            // Fall through to RAG pipeline below
          }
        }
        // ── End Agent Search Branch ──────────────────────────────────

        let transcriptChunks: TranscriptChunk[] = [];
        let transcriptSources: TranscriptSource[] = [];
        let metadataEpisodes: EpisodeMetadata[] = [];
        let metadataSources: MetadataSource[] = [];
        let metadataTotalCount = 0;
        let metadataHasMore = false;

        // Step 2: Always search both metadata + transcripts
        // Metadata search — uses extracted filters to narrow results
        send('progress', { stage: 'metadata', message: 'Searching episode data...' });
        console.log('Filters:', JSON.stringify(classification.filters));

        let result = queryEpisodes(classification.filters, {
          limit,
          offset,
          sortBy: 'episode',
          sortOrder: 'desc',
        });

        console.log('Query result:', result.returnedCount, 'of', result.totalCount, 'episodes, matched filters:', result.matchedFilters);

        // Fallback: if year filters exist but LLM's other filters produced 0 results,
        // retry with only year-based filters (decade/yearRange)
        if (result.totalCount === 0 && (classification.filters.yearRange || classification.filters.decade)) {
          const yearOnlyFilters: typeof classification.filters = {};
          if (classification.filters.decade) yearOnlyFilters.decade = classification.filters.decade;
          if (classification.filters.yearRange) yearOnlyFilters.yearRange = classification.filters.yearRange;
          console.log('Year-filter fallback:', JSON.stringify(yearOnlyFilters));
          result = queryEpisodes(yearOnlyFilters, { limit, offset, sortBy: 'episode', sortOrder: 'desc' });
          console.log('Fallback result:', result.returnedCount, 'of', result.totalCount);
        }

        // Only include metadata if meaningful filters matched (avoid passing all 300+ episodes)
        const filtersRequested = Object.keys(classification.filters).length;
        const filtersMatched = result.matchedFilters.length;
        if (filtersMatched > 0 || (filtersRequested === 0 && result.totalCount <= 50)) {
          metadataEpisodes = result.episodes;
          metadataTotalCount = result.totalCount;
          metadataHasMore = result.hasMore;
          metadataSources = metadataEpisodes.map(episodeToMetadataSource);
        }
        // Fallback for "moments/highlights" queries: use metadata notable moments to augment transcripts
        if (metadataEpisodes.length === 0) {
          const momentsFilm = extractNotableMomentsFilm(query);
          if (momentsFilm) {
            const notableResult = queryEpisodes({ film: momentsFilm }, {
              limit: 5,
              offset: 0,
              sortBy: 'episode',
              sortOrder: 'asc',
            });
            if (notableResult.episodes.length > 0) {
              metadataEpisodes = notableResult.episodes;
              metadataTotalCount = notableResult.totalCount;
              metadataHasMore = notableResult.hasMore;
              metadataSources = metadataEpisodes.map(episodeToMetadataSource);
            }
          }
        }
        // Fallback: independent notableMoments keyword search
        // Catches queries referencing podcast events/details that the classifier
        // didn't extract as filters (e.g., "Has Haitch ever lost his voice to a witch")
        if (metadataEpisodes.length === 0) {
          const notableMomentsMatches = searchNotableMoments(query);
          if (notableMomentsMatches.length > 0) {
            metadataEpisodes = notableMomentsMatches;
            metadataTotalCount = notableMomentsMatches.length;
            metadataHasMore = false;
            metadataSources = metadataEpisodes.map(episodeToMetadataSource);
            console.log('Notable moments fallback:', notableMomentsMatches.map(e => e.film));
          }
        }

        const countMessage = metadataTotalCount > 0
          ? (metadataHasMore
            ? `Found ${result.returnedCount} of ${metadataTotalCount} episodes`
            : `Found ${metadataTotalCount} episodes`)
          : 'No metadata match';
        send('progress', {
          stage: 'metadata_done',
          message: countMessage,
          totalCount: metadataTotalCount,
          hasMore: metadataHasMore,
        });

        // Transcript search — always run
        send('progress', { stage: 'transcripts', message: 'Searching transcripts...' });

        const baseK = getAdaptiveK(classification);
        const interpretiveOverrides = classification.type === 'interpretive' ? tuning?.interpretiveK : undefined;
        const finalK = interpretiveOverrides?.finalK ?? baseK.finalK;
        const hasBM25 = isBM25Available();

        send('progress', {
          stage: 'embedding',
          message: hasBM25 ? 'Running hybrid search (embedding + lexical)...' : 'Generating embedding...',
        });

        const isColdStart = !isVectorStoreLoaded();
        const targetEpisodeTitles = (metadataEpisodes.length > 0 && metadataEpisodes.length <= 10)
          ? metadataEpisodes.map(e => e.film)
          : [];
        // If classifier detected a film but metadata query returned 0 results
        // (e.g. extra filters like host narrowed too aggressively), still target
        // the detected film so retrieval injection/boost/diversification fire.
        if (targetEpisodeTitles.length === 0 && classification.filters.film) {
          targetEpisodeTitles.push(classification.filters.film);
        }
        const retrievalOptions = {
          ...(isColdStart ? { timeoutMs: 15000 } : {}),
          ...(precomputedEmbedding ? { precomputedEmbedding } : {}),
          ...(targetEpisodeTitles.length > 0 ? { targetEpisodeTitles } : {}),
          ...(classification.supplementalQueries?.length ? { supplementalQueries: classification.supplementalQueries } : {}),
          ...(supplementalEmbeddings ? { supplementalEmbeddings } : {}),
        };
        const rawRetrievalResults = await hybridRetrieval(query, classification, interpretiveOverrides,
          Object.keys(retrievalOptions).length > 0 ? retrievalOptions : undefined);
        const transcriptTimedOut = isColdStart && rawRetrievalResults.length === 0;
        const retrievalResults = transcriptTimedOut ? rawRetrievalResults : await rerankChunks(query, rawRetrievalResults);

        if (transcriptTimedOut) {
          send('progress', {
            stage: 'transcripts_timeout',
            message: 'Transcript search is still loading — using metadata results',
          });
        }

        if (retrievalResults.length > 0) {
          send('progress', {
            stage: 'searching',
            message: `Found ${retrievalResults.length} passages (K=${finalK}, BM25=${hasBM25 ? 'on' : 'off'})`,
          });

          transcriptChunks = retrievalResults.map((r) => ({
            id: r.chunk.id,
            text: r.chunk.text,
            episodeTitle: r.chunk.metadata.episodeTitle,
            speakers: r.chunk.metadata.speakers.split(', '),
            startTimestamp: r.chunk.metadata.startTimestamp,
            endTimestamp: r.chunk.metadata.endTimestamp,
          }));

          transcriptSources = retrievalResults.map((r) => {
            const epMatch = r.chunk.id.match(/episode_(\d+)/i);
            const episodeNumber = epMatch ? parseInt(epMatch[1], 10) : undefined;
            return {
              episodeTitle: r.chunk.metadata.episodeTitle,
              episodeNumber,
              speakers: r.chunk.metadata.speakers,
              startTimestamp: r.chunk.metadata.startTimestamp,
              endTimestamp: r.chunk.metadata.endTimestamp,
              text: r.chunk.text,
              score: r.score,
            };
          });
        }

        send('progress', {
          stage: 'transcripts_done',
          message: `Found ${transcriptChunks.length} relevant passages`,
        });

        // Step 3: Generate answer with streaming
        send('progress', { stage: 'synthesizing', message: 'Generating answer...' });

        // Build metadata context for synthesis
        const metadataCtx: MetadataContext | undefined = metadataTotalCount > 0
          ? {
              totalCount: metadataTotalCount,
              returnedCount: metadataEpisodes.length,
              hasMore: metadataHasMore,
            }
          : undefined;

        let answer = '';
        let chunkCount = 0;

        const useQuickSynthesis = shouldUseQuickSynthesis(depth, classification);

        if (depth === 'quick' && classification.type !== 'factual') {
          console.log('Auto-deep: interpretive/hybrid query, using full synthesis');
        } else if (depth === 'quick' && classification.type === 'factual' && classification.requiresTranscriptDepth) {
          console.log('Auto-deep: transcript-search factual query, using full chunks');
        }

        // Cap synthesis context: quick uses few chunks, deep caps at 15
        // to avoid overwhelming the model with too much context
        const DEEP_SYNTHESIS_MAX_CHUNKS = 15;
        const synthesisChunks = useQuickSynthesis
          ? transcriptChunks.slice(0, QUICK_SYNTHESIS.maxChunks)
          : transcriptChunks.slice(0, DEEP_SYNTHESIS_MAX_CHUNKS);

        const synthesisTuning = useQuickSynthesis
          ? { model: QUICK_SYNTHESIS.model, maxTokens: QUICK_SYNTHESIS.maxTokens }
          : classification.type === 'interpretive'
            ? { model: tuning?.interpretiveModel, maxTokens: tuning?.interpretiveMaxTokens }
            : undefined;

        for await (const chunk of synthesizeHybridAnswerStreaming(
          query,
          classification,
          synthesisChunks,
          metadataEpisodes,
          metadataCtx,
          synthesisTuning
        )) {
          if (chunk.type === 'chunk') {
            chunkCount++;
            // Send streaming chunks periodically to show progress
            if (chunkCount % 5 === 0) {
              send('progress', {
                stage: 'streaming',
                message: `Writing response... (${answer.length} chars)`
              });
            }
            answer += chunk.text;
            send('chunk', { text: chunk.text });
          } else if (chunk.type === 'done') {
            answer = chunk.text;
          }
        }

        if (transcriptTimedOut && metadataTotalCount > 0) {
          const note = '\n\n---\n*Transcript search is still loading — showing metadata results. Try again for full search.*';
          answer += note;
          send('chunk', { text: note });
        }

        // Step 4: Send final result
        const totalMs = Date.now() - requestStart;
        const synthesisModel = synthesisTuning?.model ?? DEEP_SYNTHESIS_MODEL;
        send('complete', {
          answer,
          queryId,
          queryType: classification.type,
          classificationConfidence: classification.confidence,
          canDeepen: useQuickSynthesis && transcriptChunks.length > QUICK_SYNTHESIS.maxChunks,
          sources: {
            transcripts: transcriptSources.length > 0 ? transcriptSources : undefined,
            metadata: metadataSources.length > 0 ? metadataSources : undefined,
          },
          metadata: {
            totalCount: metadataTotalCount,
            returnedCount: metadataEpisodes.length,
            hasMore: metadataHasMore,
          },
          perf: {
            totalMs,
            path: classification.type,
          },
        });

        controller.close();

        // Fire-and-forget query logging (after response is sent)
        const allSourceEpisodes = [
          ...(transcriptSources.map((s) => s.episodeTitle)),
          ...(metadataSources.map((s) => s.film)),
        ];
        logQuery({
          query,
          classification: {
            type: classification.type,
            confidence: classification.confidence,
            filters: { ...classification.filters },
          },
          sourceCount: transcriptSources.length + metadataSources.length,
          transcriptSourceCount: transcriptSources.length,
          metadataSourceCount: metadataSources.length,
          sourceEpisodes: [...new Set(allSourceEpisodes)],
          answerLength: answer.length,
          latencyMs: totalMs,
          path: classification.type,
          intent: { type: intent.type, confidence: intent.confidence },
          synthesisModel,
          depth,
          routingPath: 'full_pipeline',
          useCase: classifyUseCase({
            query,
            classificationType: classification.type,
            filters: { ...classification.filters },
            intentType: intent.type,
            routingPath: 'full_pipeline',
          }),
        }, queryId).catch(() => {/* already logged in logQuery */});
      } catch (error) {
        console.error('Search error:', error);
        let errorMessage = 'Unknown error';
        if (error instanceof Error) {
          errorMessage = error.message;
          if ('cause' in error && error.cause) {
            errorMessage += ` (cause: ${String(error.cause)})`;
          }
          if ('status' in error) {
            errorMessage += ` (status: ${(error as { status: number }).status})`;
          }
        }
        send('error', { message: `Search failed: ${errorMessage}` });
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
