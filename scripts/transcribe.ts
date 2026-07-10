import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { AssemblyAI } from 'assemblyai';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

// Import lexicon functions for keyterms prompt
import { getKeytermsPrompt } from '../src/lib/lexicon';

const client = new AssemblyAI({
  apiKey: process.env.ASSEMBLYAI_API_KEY || '',
});

const MP3_DIR = './mp3s';
const OUTPUT_DIR = './transcripts';

// CLI flags
const args = process.argv.slice(2);
const noBoost = args.includes('--no-boost');
const maxBoostTerms = parseInt(args.find(a => a.startsWith('--max-boost='))?.split('=')[1] || '500', 10);
const minSpeakers = parseInt(args.find(a => a.startsWith('--min-speakers='))?.split('=')[1] || '6', 10);
const maxSpeakers = parseInt(args.find(a => a.startsWith('--max-speakers='))?.split('=')[1] || '10', 10);

interface DialogueEntry {
  name: string;
  timestamp: string;
  text: string;
}

interface TranscriptOutput {
  episode_number: number;
  episode_name: string;
  dialogues: DialogueEntry[];
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function parseEpisodeInfo(filename: string): { number: number; name: string } {
  // Try to extract episode number from filename
  const match = filename.match(/(\d+)/);
  const episodeNum = match ? parseInt(match[1], 10) : 0;

  // Use filename without extension as episode name
  const name = path.basename(filename, path.extname(filename))
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { number: episodeNum, name };
}

async function promptForSpeakerMapping(
  speakers: string[],
  rl: readline.Interface
): Promise<Map<string, string>> {
  const mapping = new Map<string, string>();

  console.log('\n--- Speaker Mapping ---');
  console.log('For each detected speaker, enter the actual name (or press Enter to keep as-is):\n');

  for (const speaker of speakers) {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${speaker} -> `, resolve);
    });
    mapping.set(speaker, answer.trim() || speaker);
  }

  return mapping;
}

async function transcribeFile(
  filePath: string,
  speakerMapping?: Map<string, string>,
): Promise<{ transcript: TranscriptOutput; detectedSpeakers: string[] }> {
  const filename = path.basename(filePath);
  console.log(`\nTranscribing: ${filename}`);
  console.log('  Uploading and processing (this may take a few minutes)...');

  // Build keyterms prompt for Universal-3 Pro
  const keytermsPrompt = getKeytermsPrompt();

  // Build transcription config
  const transcriptConfig: Record<string, unknown> = {
    audio: filePath,
    speech_models: ['universal-3-5-pro', 'universal-2'],
    speaker_labels: true,
    speaker_options: {
      min_speakers_expected: minSpeakers,
      max_speakers_expected: maxSpeakers,
    },
    keyterms_prompt: keytermsPrompt,
  };
  console.log(`  Speaker range: ${minSpeakers}–${maxSpeakers}`);
  console.log(`  Keyterms prompt: ${keytermsPrompt.length} terms`);

  const transcript = await client.transcripts.transcribe(transcriptConfig as Parameters<typeof client.transcripts.transcribe>[0]);

  if (transcript.status === 'error') {
    throw new Error(`Transcription failed: ${transcript.error}`);
  }

  const utterances = transcript.utterances || [];
  const detectedSpeakers = [...new Set(utterances.map((u) => u.speaker))].sort();

  console.log(`  Detected ${detectedSpeakers.length} speakers: ${detectedSpeakers.join(', ')}`);

  const { number, name } = parseEpisodeInfo(filename);

  const dialogues: DialogueEntry[] = utterances.map((utterance) => {
    const speakerLabel = utterance.speaker;
    const mappedName = speakerMapping?.get(speakerLabel) || speakerLabel;

    return {
      name: mappedName,
      timestamp: formatTimestamp(utterance.start),
      text: utterance.text,
    };
  });

  return {
    transcript: {
      episode_number: number,
      episode_name: name,
      dialogues,
    },
    detectedSpeakers,
  };
}

async function main() {
  console.log('=== Podcast Transcription Tool ===\n');

  if (!process.env.ASSEMBLYAI_API_KEY) {
    console.error('Error: ASSEMBLYAI_API_KEY not found in .env.local');
    console.error('Get your API key at: https://www.assemblyai.com/dashboard/signup');
    process.exit(1);
  }

  // Keyterms prompt is built inside transcribeFile() via getKeytermsPrompt()
  console.log('Using AssemblyAI Universal-3 Pro with keyterms prompt.\n');

  // Check for MP3 directory
  if (!fs.existsSync(MP3_DIR)) {
    fs.mkdirSync(MP3_DIR, { recursive: true });
    console.log(`Created ${MP3_DIR} directory.`);
    console.log('Please add your MP3 files to this folder and run again.');
    process.exit(0);
  }

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Find all MP3 files
  const mp3Files = fs.readdirSync(MP3_DIR)
    .filter((f) => f.toLowerCase().endsWith('.mp3'))
    .sort();

  if (mp3Files.length === 0) {
    console.log(`No MP3 files found in ${MP3_DIR}`);
    process.exit(0);
  }

  console.log(`Found ${mp3Files.length} MP3 file(s) to transcribe.\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Ask if user wants to use a consistent speaker mapping
  const useConsistentMapping = await new Promise<boolean>((resolve) => {
    rl.question('Do you want to map speaker names? (y/n): ', (answer) => {
      resolve(answer.toLowerCase() === 'y');
    });
  });

  let globalSpeakerMapping: Map<string, string> | undefined;

  if (useConsistentMapping) {
    console.log('\nFirst, I\'ll transcribe one file to detect speakers...');

    const firstFile = path.join(MP3_DIR, mp3Files[0]);
    const { transcript, detectedSpeakers } = await transcribeFile(firstFile);

    globalSpeakerMapping = await promptForSpeakerMapping(detectedSpeakers, rl);

    // Save the first transcript
    const outputPath = path.join(
      OUTPUT_DIR,
      `${path.basename(mp3Files[0], '.mp3')}.json`
    );

    // Apply mapping to first transcript
    transcript.dialogues = transcript.dialogues.map((d) => ({
      ...d,
      name: globalSpeakerMapping?.get(d.name) || d.name,
    }));

    fs.writeFileSync(outputPath, JSON.stringify(transcript, null, 2));
    console.log(`  Saved: ${outputPath}`);

    // Remove first file from the list
    mp3Files.shift();

    console.log('\nUsing speaker mapping for remaining files:');
    globalSpeakerMapping.forEach((name, speaker) => {
      console.log(`  ${speaker} -> ${name}`);
    });
  }

  // Process remaining files
  for (const file of mp3Files) {
    const filePath = path.join(MP3_DIR, file);

    try {
      const { transcript } = await transcribeFile(filePath, globalSpeakerMapping);

      const outputPath = path.join(OUTPUT_DIR, `${path.basename(file, '.mp3')}.json`);
      fs.writeFileSync(outputPath, JSON.stringify(transcript, null, 2));
      console.log(`  Saved: ${outputPath}`);
    } catch (error) {
      console.error(`  Error transcribing ${file}:`, error);
    }
  }

  rl.close();

  console.log('\n=== Transcription Complete ===');
  console.log(`Transcripts saved to ${OUTPUT_DIR}/`);
  console.log('\nNext steps:');
  console.log('1. Review the generated JSON files');
  console.log('2. Run "npm run ingest" to index the new transcripts');
}

main().catch(console.error);
