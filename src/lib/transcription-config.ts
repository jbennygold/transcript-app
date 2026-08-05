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
 * An episode of this show has more distinct voices than it first appears:
 * Haitch, Jason, and a guest, plus the voicemail block — never fewer than 3
 * callers and often 6 or 7 — plus movie and music clips. So the real expectation
 * is roughly 7–11 speakers, and the range must not squeeze below that.
 *
 * Do not lower the ceiling to clean up small labels. A voicemailer's label looks
 * deceptively like noise — a couple hundred words, mostly short turns, smeared
 * across the runtime — because diarization mixes each caller's real voicemail
 * together with stray host backchannel. Judging those clusters as junk and
 * capping `max_speakers_expected` at 5 collapsed every caller into a host
 * (0/5 distinct) while looking like a clean result by turn-count metrics.
 *
 * Measured on ep 317, scored by whether each of the 5 voicemailers (Ethan,
 * Animal Mother, birria, Kev, Corey) lands in its own label:
 *   min=2  max=5   →  3 labels, 0/5 distinct — all 5 collapsed into hosts
 *   min=6  max=10  →  7 labels, 4/5 distinct
 *   min=8  max=10  →  9 labels, 5/5 distinct
 *   min=10 max=10  → 10 labels, 5/5 distinct
 *   min=8  max=14  → 13 labels, 5/5 distinct
 *
 * min=8/max=10 is the sweet spot: 3 hosts + 5 callers + 1 leftover cluster.
 * Raising the ceiling past 10 does not find more real voices — AssemblyAI spends
 * the extra budget splitting the *hosts* into more fragments (max=14 yields five
 * such clusters), which makes hand-mapping worse. Note the ">10 speakers"
 * limit in AssemblyAI's docs is not enforced on `speaker_options`; max=14 is
 * accepted, it just isn't useful.
 *
 * Known residual: each caller's label still carries stray host backchannel from
 * elsewhere in the episode, so bulk-mapping a label is not yet safe. That is a
 * post-processing problem, NOT something to fix by narrowing this range.
 *
 * Episodes that deviate (no voicemail block, unusually many callers) can override
 * per-run via `--min-speakers=` / `--max-speakers=` on the transcribe scripts.
 */
export const MIN_SPEAKERS_EXPECTED = 8;
export const MAX_SPEAKERS_EXPECTED = 10;
