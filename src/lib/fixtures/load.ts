import { readFileSync } from 'fs';
import path from 'path';
import type { DialogueEntry } from '@/types/transcript';

const DIR = path.join(process.cwd(), 'src/lib/fixtures/speaker-mapping');

/**
 * Paired ground truth for speaker-proposal tests: raw diarization labels and
 * the human's final mapping, index-aligned turn-for-turn.
 *
 * Refresh or add episodes with:
 *   npx tsx scripts/fetch-mapping-fixtures.ts <ep>... --commit
 */
export function loadPair(episode: number): { raw: DialogueEntry[]; mapped: DialogueEntry[] } {
  const read = (suffix: string): DialogueEntry[] =>
    JSON.parse(readFileSync(path.join(DIR, `episode_${episode}.${suffix}.json`), 'utf8'));
  return { raw: read('raw'), mapped: read('mapped') };
}
