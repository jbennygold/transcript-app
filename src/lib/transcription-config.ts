/**
 * Shared AssemblyAI transcription configuration.
 *
 * `SPEECH_MODELS` is an ordered fallback list passed to `transcripts.submit`.
 * AssemblyAI deprecated `universal-3-pro` (2026-07); `universal-3-5-pro` is its
 * prescribed successor, with `universal-2` as the fallback. Keep this list as
 * the single source of truth so a future model deprecation is a one-line change.
 */
export const SPEECH_MODELS = ['universal-3-5-pro', 'universal-2'] as const;

/**
 * Default diarization speaker range passed to `transcripts.submit`.
 *
 * The range was originally 6–10 to nudge AssemblyAI into separating voicemailers
 * and movie clips from the hosts (58d15d2). After the 2026-07-10 switch to
 * `universal-3-5-pro`, episodes started coming back with phantom speakers:
 * clusters holding a few hundred words of pure backchannel ("Yeah.", "Right.",
 * "Wow."), smeared across the whole runtime, that each had to be hand-mapped in
 * the review UI. Ep 317 landed 106 such turns across 4 phantom labels.
 *
 * The lever is the CEILING, not the floor. Per AssemblyAI's docs
 * `max_speakers_expected` is a hard upper limit, and setting it too high causes
 * over-splitting — at 10, a 3-voice episode has room to invent 4 extra clusters,
 * and `universal-3-5-pro` uses that room far more readily than `universal-3-pro`
 * did. Lowering the floor does nothing: measured on ep 317, 6→2 moved phantom
 * turns only 106→98, because the floor was never binding.
 *
 * Measured on ep 317 (all with min=2, ~20.7k words either way):
 *   max=10 → 7 labels, 4 phantom labels, 98 phantom turns
 *   max=5  → 3 labels, 0 phantom labels, 0 phantom turns
 *   max=4  → 3 labels, 0 phantom labels, 0 phantom turns
 *
 * max=5 lands on 3 labels unforced, so the ceiling isn't over-merging — it just
 * removes the excess room, while leaving headroom for a real guest or
 * voicemailer. Episodes with a known multi-voice block (several voicemailers in
 * one show) can raise it via `--max-speakers=` on the transcribe scripts.
 */
export const MIN_SPEAKERS_EXPECTED = 2;
export const MAX_SPEAKERS_EXPECTED = 5;
