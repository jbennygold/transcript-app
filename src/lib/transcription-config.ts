/**
 * Shared AssemblyAI transcription configuration.
 *
 * `SPEECH_MODELS` is an ordered fallback list passed to `transcripts.submit`.
 * AssemblyAI deprecated `universal-3-pro` (2026-07); `universal-3-5-pro` is its
 * prescribed successor, with `universal-2` as the fallback. Keep this list as
 * the single source of truth so a future model deprecation is a one-line change.
 */
export const SPEECH_MODELS = ['universal-3-5-pro', 'universal-2'] as const;
