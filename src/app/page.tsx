'use client';

import { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatEpisodeLabel } from '@/lib/episode-format';
import { CitableMarkdown } from '@/components/CitableMarkdown';
import { FeedbackForm } from '@/components/FeedbackForm';

interface TranscriptSource {
  episodeTitle: string;
  episodeNumber?: number;
  speakers: string;
  startTimestamp: string;
  endTimestamp: string;
  text: string;
  score: number;
}

interface MetadataSource {
  film: string;
  season: number;
  episode: number;
  releaseDate: string;
  guest: string | null;
  reviewer: string;
  relevantFields: Record<string, string>;
}

type QueryType = 'factual' | 'interpretive' | 'hybrid';

interface SearchResponse {
  answer: string;
  queryType: QueryType;
  queryId?: string;
  canDeepen?: boolean;
  metadata?: {
    totalCount: number;
    returnedCount: number;
    hasMore: boolean;
  };
  perf?: {
    totalMs: number;
    path: string;
  };
  sources: {
    transcripts?: TranscriptSource[];
    metadata?: MetadataSource[];
  };
}

interface ProgressState {
  stage: string;
  message: string;
  queryType?: QueryType;
}

export default function Home() {
  const [query, setQuery] = useState('');
  const [searchedQuery, setSearchedQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deepening, setDeepening] = useState(false);
  const [deepStreamingText, setDeepStreamingText] = useState('');
  const [showTranscripts, setShowTranscripts] = useState(false);
  const [followUpQuery, setFollowUpQuery] = useState('');
  const [followUpLoading, setFollowUpLoading] = useState(false);
  const [followUpStreamingText, setFollowUpStreamingText] = useState('');
  const [followUpAnswer, setFollowUpAnswer] = useState<string | null>(null);

  const runSearch = useCallback(async (searchQuery: string) => {
    const trimmed = searchQuery.trim();
    if (!trimmed) return;

    setQuery(trimmed);
    setLoading(true);
    setError(null);
    setResult(null);
    setStreamingText('');
    setDeepening(false);
    setDeepStreamingText('');
    setFollowUpQuery('');
    setFollowUpLoading(false);
    setFollowUpStreamingText('');
    setFollowUpAnswer(null);
    setSearchedQuery(trimmed);
    setProgress({ stage: 'starting', message: 'Starting search...' });

    // Update URL to reflect current query
    window.history.replaceState(null, '', '/?q=' + encodeURIComponent(trimmed));

    try {
      const response = await fetch('/api/search/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed, depth: 'quick' }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Search failed');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let eventType = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));

              if (eventType === 'progress') {
                setProgress(data);
              } else if (eventType === 'chunk') {
                setStreamingText((prev) => prev + data.text);
              } else if (eventType === 'complete') {
                setResult(data);
                setProgress(null);
                setStreamingText('');
              } else if (eventType === 'error') {
                throw new Error(data.message);
              }
            } catch (parseErr) {
              console.error('Failed to parse SSE data:', line, parseErr);
            }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setProgress(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    runSearch(query);
  };

  // Auto-search from ?q= URL parameter on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    if (q) {
      runSearch(q);
    }
  }, [runSearch]);

  const handleDeepen = async () => {
    if (!searchedQuery.trim()) return;

    setDeepening(true);
    setDeepStreamingText('');

    try {
      const response = await fetch('/api/search/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchedQuery, depth: 'deep' }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Deep analysis failed');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let eventType = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));

              if (eventType === 'chunk') {
                setDeepStreamingText((prev) => prev + data.text);
              } else if (eventType === 'complete') {
                setResult(data);
                setDeepStreamingText('');
              } else if (eventType === 'error') {
                throw new Error(data.message);
              }
            } catch (parseErr) {
              if (parseErr instanceof Error && parseErr.message.startsWith('Deep analysis failed')) throw parseErr;
              console.error('Failed to parse SSE data:', line, parseErr);
            }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deep analysis failed');
    } finally {
      setDeepening(false);
    }
  };

  const handleFollowUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!followUpQuery.trim() || !result) return;

    setFollowUpLoading(true);
    setFollowUpStreamingText('');
    setFollowUpAnswer(null);

    try {
      const response = await fetch('/api/search/followup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: searchedQuery,
          followUpQuery: followUpQuery.trim(),
          previousAnswer: result.answer,
          sources: result.sources,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Follow-up failed');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let eventType = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));

              if (eventType === 'chunk') {
                setFollowUpStreamingText((prev) => prev + data.text);
              } else if (eventType === 'complete') {
                setFollowUpAnswer(data.answer);
                setFollowUpStreamingText('');
              } else if (eventType === 'error') {
                throw new Error(data.message);
              }
            } catch (parseErr) {
              if (parseErr instanceof Error && parseErr.message.startsWith('Follow-up failed')) throw parseErr;
              console.error('Failed to parse SSE data:', line, parseErr);
            }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Follow-up failed');
    } finally {
      setFollowUpLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="bg-gradient-to-br from-brand-dark to-brand-plum">
        <div className="max-w-4xl mx-auto px-4 pt-10 pb-8">
          <header className="text-center mb-8">
            <div className="flex items-center justify-center gap-3 mb-2">
              <img src="/logo.jpg" alt="Escape Hatch Podcast" className="w-12 h-12 rounded-full" />
              <h1 className="text-4xl font-bold text-white">
                Escape Hatch Podcast Search
              </h1>
            </div>
            <p className="text-gray-300">
              Ask questions about podcast episodes and get answers with quotes
            </p>
          </header>

          <form onSubmit={handleSearch}>
            <div className="flex gap-3">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="What have you said about Steven Spielberg?"
                className="flex-1 px-4 py-3 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-plum focus:border-transparent text-gray-900 placeholder-gray-400"
                disabled={loading}
              />
              <button
                type="submit"
                disabled={loading || !query.trim()}
                className="px-6 py-3 bg-brand-plum text-white rounded-lg font-medium hover:bg-brand-plum-light disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? 'Searching...' : 'Search'}
              </button>
            </div>
          </form>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-8">

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-8">
            <p className="text-red-700">{error}</p>
          </div>
        )}

        {loading && progress && <SearchProgress progress={progress} streamingText={streamingText} />}

        {result && (
          <div className="space-y-8">
            <AnswerCard
              result={result}
              query={searchedQuery}
              onDeepen={handleDeepen}
              deepening={deepening}
              deepStreamingText={deepStreamingText}
            />

            {/* Follow-up answer */}
            {(followUpAnswer || followUpStreamingText) && (
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Follow-up</h2>
                <article className="prose prose-slate prose-headings:text-gray-900 max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {followUpAnswer || followUpStreamingText}
                  </ReactMarkdown>
                  {followUpStreamingText && !followUpAnswer && (
                    <span className="inline-block w-2 h-4 bg-brand-plum animate-pulse ml-1" />
                  )}
                </article>
              </div>
            )}

            {/* Follow-up input */}
            <form onSubmit={handleFollowUp} className="flex gap-3">
              <input
                type="text"
                value={followUpQuery}
                onChange={(e) => setFollowUpQuery(e.target.value)}
                placeholder="Ask a follow-up question..."
                className="flex-1 px-4 py-3 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-plum focus:border-transparent text-gray-900 placeholder-gray-400"
                disabled={followUpLoading}
              />
              <button
                type="submit"
                disabled={followUpLoading || !followUpQuery.trim()}
                className="px-6 py-3 bg-brand-plum text-white rounded-lg font-medium hover:bg-brand-plum-light disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {followUpLoading ? 'Thinking...' : 'Ask'}
              </button>
            </form>

            {result.sources.transcripts && result.sources.transcripts.length > 0 && (
              <div>
                <button
                  onClick={() => setShowTranscripts(prev => !prev)}
                  className="flex items-center gap-2 text-lg font-semibold text-gray-900 hover:text-gray-700 transition-colors"
                >
                  <span className={`transition-transform ${showTranscripts ? 'rotate-90' : ''}`}>&#9654;</span>
                  Transcript Sources ({result.sources.transcripts.length})
                </button>
                {showTranscripts && (
                  <div className="space-y-4 mt-4">
                    {result.sources.transcripts.map((source, index) => (
                      <TranscriptCard key={index} source={source} />
                    ))}
                  </div>
                )}
              </div>
            )}

            <FeedbackForm query={searchedQuery} answer={result.answer} queryType={result.queryType} queryLogId={result.queryId} />
          </div>
        )}

        {!result && !loading && !error && (
          <div className="text-center text-gray-500 py-12">
            <p>Try asking questions like:</p>
            <ul className="mt-4 space-y-2 text-left max-w-md mx-auto">
              <li className="flex items-start gap-2">
                <span className="text-blue-500 text-xs font-medium bg-blue-50 px-1.5 py-0.5 rounded mt-0.5">factual</span>
                <span>&ldquo;How many episodes feature Proto as a guest?&rdquo;</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-purple-500 text-xs font-medium bg-purple-50 px-1.5 py-0.5 rounded mt-0.5">interpretive</span>
                <span>&ldquo;What did Jason say about Denis Villeneuve?&rdquo;</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-green-500 text-xs font-medium bg-green-50 px-1.5 py-0.5 rounded mt-0.5">hybrid</span>
                <span>&ldquo;Which 80s movies did they enjoy most?&rdquo;</span>
              </li>
            </ul>
          </div>
        )}
      </div>
    </main>
  );
}

function QueryTypeBadge({ type }: { type: QueryType }) {
  const styles = {
    factual: 'bg-blue-50 text-blue-600 border-blue-200',
    interpretive: 'bg-purple-50 text-purple-600 border-purple-200',
    hybrid: 'bg-green-50 text-green-600 border-green-200',
  };

  const labels = {
    factual: 'Factual Query',
    interpretive: 'Interpretive Query',
    hybrid: 'Hybrid Query',
  };

  return (
    <span
      className={`text-xs font-medium px-2 py-1 rounded-full border ${styles[type]}`}
    >
      {labels[type]}
    </span>
  );
}

function AnswerCard({ result, query, onDeepen, deepening, deepStreamingText }: {
  result: SearchResponse;
  query: string;
  onDeepen: () => void;
  deepening: boolean;
  deepStreamingText: string;
}) {
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [shareStatus, setShareStatus] = useState<'idle' | 'sharing' | 'copied' | 'error'>('idle');

  const handleShare = async () => {
    setShareStatus('sharing');
    try {
      const response = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, result }),
      });

      if (!response.ok) {
        throw new Error('Failed to create share');
      }

      const { url } = await response.json();
      const fullUrl = `${window.location.origin}${url}`;
      await navigator.clipboard.writeText(fullUrl);
      setShareStatus('copied');

      // Reset after 3 seconds
      setTimeout(() => setShareStatus('idle'), 3000);
    } catch (err) {
      console.error('Share error:', err);
      setShareStatus('error');
      setTimeout(() => setShareStatus('idle'), 3000);
    }
  };

  const handleReportError = () => {
    const selection = window.getSelection();
    const selected = selection?.toString().trim() || '';
    setSelectedText(selected);
    setShowErrorModal(true);
  };

  // Build a combined source for the error modal from all transcript sources
  const combinedSource: TranscriptSource | null = result.sources.transcripts && result.sources.transcripts.length > 0
    ? {
        episodeTitle: result.sources.transcripts.map(t => t.episodeTitle).join(', '),
        speakers: [...new Set(result.sources.transcripts.flatMap(t => t.speakers.split(', ')))].join(', '),
        startTimestamp: result.sources.transcripts[0].startTimestamp,
        endTimestamp: result.sources.transcripts[result.sources.transcripts.length - 1].endTimestamp,
        text: result.answer,
        score: 1,
      }
    : null;

  const metadataPath = result.perf?.path ?? '';
  const isMetadataIntentOnly = metadataPath.startsWith('metadata');
  const metadataSources = result.sources.metadata ?? [];
  const metadataCount = typeof result.metadata?.totalCount === 'number'
    ? result.metadata.totalCount
    : metadataSources.length;
  const metadataSubtitle = metadataCount > 0
    ? `${metadataCount} episode${metadataCount === 1 ? '' : 's'} matched`
    : 'No matching episode metadata';
  const metadataSummary = metadataSources.length === 1
    ? `${formatEpisodeLabel(metadataSources[0].season, metadataSources[0].episode)} — "${metadataSources[0].film}"`
    : metadataSources.length > 1
      ? `${metadataSources
          .slice(0, 2)
          .map((source) => `"${source.film}"`)
          .join(' · ')}${metadataSources.length > 2 ? ` +${metadataSources.length - 2} more` : ''}`
      : '';

  const shareButton = (
    <button
      onClick={handleShare}
      disabled={shareStatus === 'sharing'}
      className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
        shareStatus === 'copied'
          ? 'bg-green-100 text-green-700'
          : shareStatus === 'error'
          ? 'bg-red-100 text-red-700'
          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
      }`}
    >
      {shareStatus === 'sharing' ? 'Sharing...' :
       shareStatus === 'copied' ? 'Copied!' :
       shareStatus === 'error' ? 'Error' :
       'Share'}
    </button>
  );

  return (
    <>
      <div
        className={
          isMetadataIntentOnly
            ? 'bg-[#f8f9fa] border border-[#dadce0] rounded-xl shadow-sm p-6'
            : 'bg-white rounded-lg shadow-sm border border-gray-200 p-6'
        }
      >
        {isMetadataIntentOnly ? (
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-500">
                Quick Answer from POD DATA CENTRAL
              </p>
              <p className="text-xs text-gray-500 mt-1">{metadataSubtitle}</p>
              <div className="h-5 mt-2" />
            </div>
            {shareButton}
          </div>
        ) : (
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold text-gray-900">Answer</h2>
              <QueryTypeBadge type={result.queryType} />
            </div>
            {shareButton}
          </div>
        )}
        <article
          className={
            isMetadataIntentOnly
              ? 'prose prose-slate prose-headings:text-gray-900 max-w-none text-[15px] leading-relaxed'
              : 'prose prose-slate prose-headings:text-gray-900 max-w-none'
          }
        >
          <CitableMarkdown content={result.answer} sources={result.sources?.transcripts ?? []} />
        </article>
        {isMetadataIntentOnly && metadataSummary && (
          <div className="mt-4 pt-4 border-t border-[#dadce0]">
            <p className="text-xs text-gray-600">
              {metadataSources.length === 1 ? 'Episode' : 'Episodes'}: {metadataSummary}
            </p>
            {(() => {
              const reviewers = [...new Set(metadataSources.map(s => s.reviewer).filter(Boolean))];
              if (reviewers.length === 0) return null;
              return (
                <p className="text-xs text-gray-400 mt-1">
                  Thank you PDC reviewer{reviewers.length > 1 ? 's' : ''}, {reviewers.join(', ')}
                </p>
              );
            })()}
          </div>
        )}
        {deepening && deepStreamingText && (
          <div className="mt-4 pt-4 border-t border-gray-200">
            <p className="text-xs font-medium text-gray-500 mb-2">Deeper analysis:</p>
            <article className="prose prose-sm prose-slate prose-headings:text-gray-900 max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {deepStreamingText}
              </ReactMarkdown>
              <span className="inline-block w-2 h-4 bg-brand-plum animate-pulse ml-1" />
            </article>
          </div>
        )}
        <div className="mt-4 pt-4 border-t border-gray-100 flex items-center gap-4">
          {result.canDeepen && !deepening && (
            <button
              onClick={onDeepen}
              className="text-sm text-brand-plum hover:text-brand-plum-light font-medium transition-colors"
            >
              Show deeper analysis
            </button>
          )}
          {deepening && !deepStreamingText && (
            <span className="text-sm text-gray-500 flex items-center gap-2">
              <span className="inline-block w-3 h-3 border-2 border-brand-plum border-t-transparent rounded-full animate-spin" />
              Generating deeper analysis...
            </span>
          )}
          {combinedSource && (
            <button
              onClick={handleReportError}
              className="text-xs text-gray-400 hover:text-red-500 transition-colors ml-auto"
            >
              Bad transcription?
            </button>
          )}
        </div>
      </div>

      {showErrorModal && combinedSource && (
        <AnswerErrorModal
          result={result}
          initialSelectedText={selectedText}
          onClose={() => setShowErrorModal(false)}
        />
      )}
    </>
  );
}

function MetadataCard({ source }: { source: MetadataSource }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="font-medium text-gray-900">{source.film}</h3>
          <p className="text-sm text-gray-500">
            {formatEpisodeLabel(source.season, source.episode)} &bull; {source.releaseDate}
          </p>
        </div>
      </div>
      <div className="text-sm text-gray-600 space-y-1">
        <p>
          <span className="text-gray-400">Reviewer:</span> {source.reviewer}
        </p>
        {source.guest && (
          <p>
            <span className="text-gray-400">Guest:</span> {source.guest}
          </p>
        )}
        {Object.entries(source.relevantFields).length > 0 && (
          <div className="mt-2 pt-2 border-t border-gray-100">
            {Object.entries(source.relevantFields)
              .slice(0, 2)
              .map(([key, value]) => (
                <p key={key} className="text-xs text-gray-500 truncate">
                  <span className="font-medium">{key}:</span> {value}
                </p>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TranscriptCard({ source }: { source: TranscriptSource }) {
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [selectedText, setSelectedText] = useState('');

  const handleReportError = () => {
    // Get any text the user has selected
    const selection = window.getSelection();
    const selected = selection?.toString().trim() || '';
    setSelectedText(selected);
    setShowErrorModal(true);
  };

  return (
    <>
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="flex items-start justify-between mb-2">
          <div>
            <h3 className="font-medium text-gray-900">{source.episodeTitle}</h3>
            <p className="text-sm text-gray-500">
              {source.speakers} &bull; {source.startTimestamp} -{' '}
              {source.endTimestamp}
            </p>
          </div>
          <span className="text-xs text-gray-400">
            {(source.score * 100).toFixed(0)}% match
          </span>
        </div>
        <p className="text-gray-600 text-sm whitespace-pre-wrap select-text">
          {source.text.length > 500
            ? source.text.slice(0, 500) + '...'
            : source.text}
        </p>
        <div className="mt-2 pt-2 border-t border-gray-100">
          <button
            onClick={handleReportError}
            className="text-xs text-gray-400 hover:text-red-500 transition-colors"
          >
            Bad transcription?
          </button>
        </div>
      </div>

      {showErrorModal && (
        <TranscriptionErrorModal
          source={source}
          initialSelectedText={selectedText}
          onClose={() => setShowErrorModal(false)}
        />
      )}
    </>
  );
}

function TranscriptionErrorModal({
  source,
  initialSelectedText,
  onClose,
}: {
  source: TranscriptSource;
  initialSelectedText: string;
  onClose: () => void;
}) {
  const [selectedText, setSelectedText] = useState(initialSelectedText);
  const [correctedText, setCorrectedText] = useState(initialSelectedText);
  const [reporterName, setReporterName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedText.trim() || !correctedText.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/transcription-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          episodeTitle: source.episodeTitle,
          episodeNumber: source.episodeNumber,
          startTimestamp: source.startTimestamp,
          endTimestamp: source.endTimestamp,
          speakers: source.speakers,
          originalText: source.text,
          selectedText: selectedText.trim(),
          correctedText: correctedText.trim(),
          reporterName: reporterName.trim() || undefined,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to submit report');
      }

      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit report');
    } finally {
      setSubmitting(false);
    }
  };

  // Close on escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  if (submitted) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
        <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6" onClick={(e) => e.stopPropagation()}>
          <div className="text-center">
            <div className="text-4xl mb-4">✅</div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Thank you!</h3>
            <p className="text-gray-600 mb-4">
              Your transcription correction has been submitted and will be reviewed.
            </p>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-brand-plum text-white rounded-lg hover:bg-brand-plum-light"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Report Transcription Error</h3>
              <p className="text-sm text-gray-500 mt-1">{source.episodeTitle}</p>
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 text-xl leading-none"
            >
              ×
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-600">
            <p className="font-medium text-gray-700 mb-1">Tip:</p>
            <p>
              Before clicking &ldquo;Bad transcription?&rdquo;, highlight the incorrect text in the
              transcript to auto-fill the field below.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Incorrect Text <span className="text-red-500">*</span>
            </label>
            <textarea
              value={selectedText}
              onChange={(e) => setSelectedText(e.target.value)}
              placeholder="Paste or type the incorrectly transcribed text here"
              rows={3}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent text-gray-900 resize-none"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Corrected Text <span className="text-red-500">*</span>
            </label>
            <textarea
              value={correctedText}
              onChange={(e) => setCorrectedText(e.target.value)}
              placeholder="Enter the correct transcription"
              rows={3}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900 resize-none"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Your Name (optional)
            </label>
            <input
              type="text"
              value={reporterName}
              onChange={(e) => setReporterName(e.target.value)}
              placeholder="Enter your name"
              className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-plum focus:border-transparent text-gray-900"
            />
          </div>

          <div className="bg-brand-plum-lighter rounded-lg p-3 text-sm">
            <p className="text-brand-plum">
              <span className="font-medium">Context info that will be included:</span>
            </p>
            <ul className="mt-1 text-brand-plum-muted text-xs space-y-0.5">
              <li>• Episode: {source.episodeTitle}</li>
              <li>• Timestamp: {source.startTimestamp} - {source.endTimestamp}</li>
              <li>• Speakers: {source.speakers}</li>
            </ul>
          </div>

          {error && (
            <div className="text-red-600 text-sm bg-red-50 p-3 rounded-lg">{error}</div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 px-4 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!selectedText.trim() || !correctedText.trim() || submitting}
              className="flex-1 py-2 px-4 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Submitting...' : 'Submit Correction'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AnswerErrorModal({
  result,
  initialSelectedText,
  onClose,
}: {
  result: SearchResponse;
  initialSelectedText: string;
  onClose: () => void;
}) {
  const [selectedText, setSelectedText] = useState(initialSelectedText);
  const [correctedText, setCorrectedText] = useState(initialSelectedText);
  const [reporterName, setReporterName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Get episode info from transcript sources
  const transcripts = result.sources.transcripts || [];
  const episodeTitle = transcripts.length > 0
    ? transcripts.map(t => t.episodeTitle).filter((v, i, a) => a.indexOf(v) === i).join(', ')
    : 'Multiple episodes';
  const episodeNumbers = transcripts
    .map(t => t.episodeNumber)
    .filter((n): n is number => n !== undefined);
  const episodeNumber = episodeNumbers.length > 0 ? episodeNumbers[0] : undefined;
  const speakers = transcripts.length > 0
    ? [...new Set(transcripts.flatMap(t => t.speakers.split(', ')))].join(', ')
    : 'Unknown';
  const startTimestamp = transcripts.length > 0 ? transcripts[0].startTimestamp : 'unknown';
  const endTimestamp = transcripts.length > 0 ? transcripts[transcripts.length - 1].endTimestamp : 'unknown';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedText.trim() || !correctedText.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/transcription-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          episodeTitle,
          episodeNumber,
          startTimestamp,
          endTimestamp,
          speakers,
          originalText: result.answer,
          selectedText: selectedText.trim(),
          correctedText: correctedText.trim(),
          reporterName: reporterName.trim() || undefined,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to submit report');
      }

      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit report');
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  if (submitted) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
        <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6" onClick={(e) => e.stopPropagation()}>
          <div className="text-center">
            <div className="text-4xl mb-4">✅</div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Thank you!</h3>
            <p className="text-gray-600 mb-4">
              Your transcription correction has been submitted and will be reviewed.
            </p>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-brand-plum text-white rounded-lg hover:bg-brand-plum-light"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Report Transcription Error</h3>
              <p className="text-sm text-gray-500 mt-1">{episodeTitle}</p>
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 text-xl leading-none"
            >
              ×
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-600">
            <p className="font-medium text-gray-700 mb-1">Tip:</p>
            <p>
              Before clicking &ldquo;Bad transcription?&rdquo;, highlight the incorrect text in the
              answer to auto-fill the field below.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Incorrect Text <span className="text-red-500">*</span>
            </label>
            <textarea
              value={selectedText}
              onChange={(e) => setSelectedText(e.target.value)}
              placeholder="Paste or type the incorrectly transcribed text here"
              rows={3}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent text-gray-900 resize-none"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Corrected Text <span className="text-red-500">*</span>
            </label>
            <textarea
              value={correctedText}
              onChange={(e) => setCorrectedText(e.target.value)}
              placeholder="Enter the correct transcription"
              rows={3}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900 resize-none"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Your Name (optional)
            </label>
            <input
              type="text"
              value={reporterName}
              onChange={(e) => setReporterName(e.target.value)}
              placeholder="Enter your name"
              className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-plum focus:border-transparent text-gray-900"
            />
          </div>

          <div className="bg-brand-plum-lighter rounded-lg p-3 text-sm">
            <p className="text-brand-plum">
              <span className="font-medium">Context info that will be included:</span>
            </p>
            <ul className="mt-1 text-brand-plum-muted text-xs space-y-0.5">
              <li>• Episode(s): {episodeTitle}</li>
              <li>• Speakers: {speakers}</li>
            </ul>
          </div>

          {error && (
            <div className="text-red-600 text-sm bg-red-50 p-3 rounded-lg">{error}</div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 px-4 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!selectedText.trim() || !correctedText.trim() || submitting}
              className="flex-1 py-2 px-4 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Submitting...' : 'Submit Correction'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const STAGE_CONFIG: Record<string, { icon: string; step: number }> = {
  starting: { icon: '🚀', step: 0 },
  classifying: { icon: '🔍', step: 0 },
  classified: { icon: '🔍', step: 1 },
  metadata: { icon: '📊', step: 1 },
  metadata_done: { icon: '📊', step: 2 },
  transcripts: { icon: '📜', step: 1 },
  embedding: { icon: '🧮', step: 2 },
  searching: { icon: '🔎', step: 2 },
  transcripts_done: { icon: '📜', step: 3 },
  synthesizing: { icon: '✨', step: 3 },
  streaming: { icon: '✍️', step: 3 },
};

const PROGRESS_STEPS = [
  'Analyze',
  'Search',
  'Process',
  'Generate',
];

function SearchProgress({ progress, streamingText }: { progress: ProgressState; streamingText: string }) {
  const [dots, setDots] = useState('');

  useEffect(() => {
    const dotsInterval = setInterval(() => {
      setDots((prev) => (prev.length >= 3 ? '' : prev + '.'));
    }, 400);

    return () => clearInterval(dotsInterval);
  }, []);

  const config = STAGE_CONFIG[progress.stage] || { icon: '⏳', step: 0 };
  const currentStep = config.step;

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 mb-8">
      <div className="flex flex-col items-center">
        {/* Spinner */}
        <div className="relative mb-6">
          <div className="w-12 h-12 rounded-full border-4 border-gray-200"></div>
          <div className="absolute top-0 left-0 w-12 h-12 rounded-full border-4 border-brand-plum border-t-transparent animate-spin"></div>
        </div>

        {/* Current stage */}
        <div className="text-center mb-6">
          <span className="text-2xl mb-2 block">{config.icon}</span>
          <p className="text-gray-700 font-medium">
            {progress.message}
            <span className="inline-block w-6 text-left">{dots}</span>
          </p>
          {progress.queryType && (
            <span className="inline-block mt-2 text-xs text-gray-500">
              Query type: <span className="font-medium">{progress.queryType}</span>
            </span>
          )}
        </div>

        {/* Progress steps */}
        <div className="flex items-center gap-2">
          {PROGRESS_STEPS.map((step, index) => (
            <div
              key={step}
              className={`flex items-center ${index < PROGRESS_STEPS.length - 1 ? 'gap-2' : ''}`}
            >
              <div
                className={`w-2.5 h-2.5 rounded-full transition-all duration-300 ${
                  index <= currentStep
                    ? 'bg-brand-plum scale-110'
                    : 'bg-gray-200'
                }`}
              />
              {index < PROGRESS_STEPS.length - 1 && (
                <div
                  className={`w-8 h-0.5 transition-colors duration-300 ${
                    index < currentStep ? 'bg-brand-plum' : 'bg-gray-200'
                  }`}
                />
              )}
            </div>
          ))}
        </div>

        {/* Stage labels */}
        <div className="flex gap-2 mt-2 text-xs text-gray-400">
          {PROGRESS_STEPS.map((step, index) => (
            <span
              key={step}
              className={`w-12 text-center ${
                index === currentStep ? 'text-brand-plum font-medium' : ''
              }`}
            >
              {step}
            </span>
          ))}
        </div>

        {/* Streaming text preview */}
        {streamingText && (
          <div className="mt-6 w-full border-t border-gray-200 pt-4">
            <article className="prose prose-sm prose-slate prose-headings:text-gray-900 max-w-none max-h-64 overflow-y-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {streamingText}
              </ReactMarkdown>
              <span className="inline-block w-2 h-4 bg-brand-plum animate-pulse ml-1" />
            </article>
          </div>
        )}
      </div>
    </div>
  );
}

// FeedbackForm extracted to @/components/FeedbackForm
