/**
 * Scores speaker-proposal against every paired episode in Blob.
 *
 *   npx tsx scripts/fetch-mapping-fixtures.ts     # populate /tmp first
 *   npm run score:speakers
 *
 * Floors are the measured baseline from the design spec. Correct names may go
 * up; MIS-NAMES MAY NOT GO UP. Declining is cheap, a wrong name is not.
 */
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import type { DialogueEntry } from '../src/types/transcript';
import { classifyLabels, isolateCallerRun, nameCaller, countWords } from '../src/lib/speaker-proposal';

const DIR = '/tmp/speaker-mapping-fixtures';
const MIN_CORRECT = 59;
const MAX_MISNAMED = 2;

function main() {
  let episodes = 0;
  let correct = 0;
  let declined = 0;
  let misnamed = 0;
  const failures: string[] = [];

  const files = readdirSync(DIR).filter((f) => f.endsWith('.raw.json')).sort();
  if (files.length === 0) {
    console.error(`No fixtures in ${DIR}. Run: npx tsx scripts/fetch-mapping-fixtures.ts`);
    process.exit(1);
  }

  for (const file of files) {
    const ep = Number(file.match(/\d+/)?.[0]);
    const raw: DialogueEntry[] = JSON.parse(readFileSync(path.join(DIR, file), 'utf8'));
    const mapped: DialogueEntry[] = JSON.parse(
      readFileSync(path.join(DIR, `episode_${ep}.mapped.json`), 'utf8'));
    if (raw.length !== mapped.length) continue;
    episodes++;

    for (const label of classifyLabels(raw).filter((l) => l.kind === 'caller')) {
      const run = isolateCallerRun(raw, label.indices);
      if (run.length === 0) continue;
      const longest = run.reduce((a, b) => (countWords(raw[a].text) > countWords(raw[b].text) ? a : b));
      const truth = mapped[longest].name;
      const proposed = nameCaller(raw, run);

      if (proposed === truth) correct++;
      else if (proposed === null) declined++;
      else {
        misnamed++;
        failures.push(`ep${ep} ${label.label}: truth="${truth}" proposed="${proposed}"`);
      }
    }
  }

  console.log(`episodes scored: ${episodes}`);
  console.log(`correct: ${correct}  declined: ${declined}  MIS-NAMED: ${misnamed}`);
  if (failures.length) {
    console.log('\nmis-names:');
    for (const f of failures) console.log('  ' + f);
  }

  let failed = false;
  if (correct < MIN_CORRECT) {
    console.error(`\nFAIL: correct ${correct} < floor ${MIN_CORRECT}`);
    failed = true;
  }
  if (misnamed > MAX_MISNAMED) {
    console.error(`\nFAIL: mis-named ${misnamed} > ceiling ${MAX_MISNAMED}`);
    failed = true;
  }
  if (failed) process.exit(1);
  console.log('\nPASS');
}

main();
