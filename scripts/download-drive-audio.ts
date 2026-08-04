/**
 * Download MP3 files from Google Drive for episodes missing transcripts.
 *
 * Usage:
 *   npm run download-audio                        # Download for episodes missing transcripts
 *   npm run download-audio -- --missing-mp3s      # Download for episodes missing MP3 files
 *   npm run download-audio -- --dry-run            # Just show matches, don't download
 *   npm run download-audio -- --list               # List all folders in Drive
 *   npm run download-audio -- --episodes 230,239,241 # Download specific episodes
 *
 * Prerequisites:
 *   - Service account key file configured in .env.local
 *   - "Audio Files" folder shared with service account email
 *   - Google Drive API enabled in Google Cloud Console
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { google, drive_v3 } from 'googleapis';
import { loadEpisodeMetadata } from '../src/lib/metadata-store';
import { type EpisodeId } from '../src/lib/episode-format';
import {
  fetchPodcastFeed,
  findItemByFilm,
  downloadEnclosureToFile,
  getFeedUrl,
  type PodcastFeedItem,
} from '../src/lib/podcast-feed';
import {
  scoreFolderAgainstFilm,
  suggestFolders,
  MATCH_THRESHOLD,
  type UnresolvedEpisode,
} from '../src/lib/drive-match';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const listOnly = args.includes('--list');
const verbose = args.includes('--verbose');
const missingMp3sMode = args.includes('--missing-mp3s');

function getArgValue(flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  const prefixed = args.find(a => a.startsWith(`${flag}=`));
  if (prefixed) return prefixed.split('=', 2)[1] || null;
  return null;
}

const episodesArg = getArgValue('--episodes');
const episodeOverrides = episodesArg
  ? episodesArg
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  : null;

const MP3_DIR = './mp3s';
const TRANSCRIPTS_DIR = './transcripts';

interface DriveFolder {
  id: string;
  name: string;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
}

interface EpisodeMissing {
  episode: EpisodeId;
  film: string;
  season: number;
}

// ---------- Google Drive Auth ----------

async function getDriveClient(): Promise<drive_v3.Drive> {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;

  if (!keyFile) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_FILE not set in .env.local');
  }

  const keyPath = path.resolve(process.cwd(), keyFile);
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Service account key file not found: ${keyPath}`);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });

  return google.drive({ version: 'v3', auth });
}

// ---------- Drive Operations ----------

async function findAudioFilesFolder(drive: drive_v3.Drive): Promise<string | null> {
  console.log('Searching for "Audio Files" folder...');

  const response = await drive.files.list({
    q: "name = 'Audio Files' and mimeType = 'application/vnd.google-apps.folder'",
    fields: 'files(id, name)',
    spaces: 'drive',
  });

  const folders = response.data.files || [];

  if (folders.length === 0) {
    return null;
  }

  if (folders.length > 1) {
    console.log(`Found ${folders.length} folders named "Audio Files":`);
    folders.forEach(f => console.log(`  - ${f.id}: ${f.name}`));
    console.log('Using the first one.');
  }

  return folders[0].id!;
}

async function listSubfolders(drive: drive_v3.Drive, parentId: string): Promise<DriveFolder[]> {
  const folders: DriveFolder[] = [];
  let pageToken: string | undefined;

  do {
    const response = await drive.files.list({
      q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder'`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 100,
      pageToken,
    });

    const files = response.data.files || [];
    for (const file of files) {
      if (file.id && file.name) {
        folders.push({ id: file.id, name: file.name });
      }
    }

    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  return folders.sort((a, b) => a.name.localeCompare(b.name));
}

async function listFilesInFolder(drive: drive_v3.Drive, folderId: string): Promise<DriveFile[]> {
  const response = await drive.files.list({
    q: `'${folderId}' in parents`,
    fields: 'files(id, name, mimeType, size)',
  });

  return (response.data.files || []).map(f => ({
    id: f.id!,
    name: f.name!,
    mimeType: f.mimeType!,
    size: f.size || undefined,
  }));
}

async function downloadFile(drive: drive_v3.Drive, fileId: string, destPath: string): Promise<void> {
  const dest = fs.createWriteStream(destPath);

  const response = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  return new Promise((resolve, reject) => {
    (response.data as NodeJS.ReadableStream)
      .on('end', () => {
        dest.close();
        resolve();
      })
      .on('error', (err: Error) => {
        dest.close();
        fs.unlinkSync(destPath);
        reject(err);
      })
      .pipe(dest);
  });
}

// ---------- Episode Matching ----------

function getEpisodesMissingTranscripts(): EpisodeMissing[] {
  const metadata = loadEpisodeMetadata();

  // Get list of existing transcripts
  const existingTranscripts = new Set<EpisodeId>();

  if (fs.existsSync(TRANSCRIPTS_DIR)) {
    const files = fs.readdirSync(TRANSCRIPTS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(TRANSCRIPTS_DIR, file), 'utf-8'));
        if (content.episode_number) {
          existingTranscripts.add(content.episode_number);
        }
      } catch {
        // Skip
      }
    }
  }

  // Filter to episodes without transcripts
  return metadata
    .filter(ep => !existingTranscripts.has(ep.episode))
    .map(ep => ({
      episode: ep.episode,
      film: ep.film,
      season: ep.season,
    }));
}

function getEpisodesMissingMp3s(): EpisodeMissing[] {
  const metadata = loadEpisodeMetadata();

  const existingMp3s = new Set<string>();
  if (fs.existsSync(MP3_DIR)) {
    const files = fs.readdirSync(MP3_DIR).filter(f => f.endsWith('.mp3'));
    for (const file of files) {
      // Strip .mp3 extension to get episode ID (e.g., "206.mp3" → "206", "147b1.mp3" → "147b1")
      existingMp3s.add(file.replace(/\.mp3$/i, ''));
    }
  }

  return metadata
    .filter(ep => !existingMp3s.has(String(ep.episode)))
    .map(ep => ({
      episode: ep.episode,
      film: ep.film,
      season: ep.season,
    }));
}

function getEpisodesByNumber(episodes: EpisodeId[]): EpisodeMissing[] {
  const metadata = loadEpisodeMetadata();
  const episodeSet = new Set(episodes.map(e => String(e).trim().toLowerCase()));

  const matches = metadata
    .filter(ep => episodeSet.has(String(ep.episode).trim().toLowerCase()))
    .map(ep => ({
      episode: ep.episode,
      film: ep.film,
      season: ep.season,
    }));

  const found = new Set(matches.map(m => String(m.episode).trim().toLowerCase()));
  const missing = episodes.filter(n => !found.has(String(n).trim().toLowerCase()));
  if (missing.length > 0) {
    console.warn(`Warning: ${missing.length} episode(s) not found in metadata: ${missing.map(String).join(', ')}`);
  }

  return matches;
}

function matchFolderToEpisode(folderName: string, episodes: EpisodeMissing[]): EpisodeMissing | null {
  let bestMatch: EpisodeMissing | null = null;
  let bestScore = 0;

  for (const ep of episodes) {
    const score = scoreFolderAgainstFilm(folderName, ep.film);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = ep;
    }
  }

  return bestScore >= MATCH_THRESHOLD ? bestMatch : null;
}

// ---------- Main ----------

async function main() {
  console.log('=== Download Audio from Google Drive ===\n');

  if (dryRun) {
    console.log('DRY RUN - no files will be downloaded\n');
  }

  // Ensure mp3s directory exists
  if (!fs.existsSync(MP3_DIR)) {
    fs.mkdirSync(MP3_DIR, { recursive: true });
  }

  // Get Drive client
  const drive = await getDriveClient();
  console.log('Authenticated with Google Drive.\n');

  // Find Audio Files folder
  const audioFolderId = await findAudioFilesFolder(drive);
  if (!audioFolderId) {
    console.error('Could not find "Audio Files" folder. Make sure it\'s shared with the service account.');
    process.exit(1);
  }
  console.log(`Found "Audio Files" folder: ${audioFolderId}\n`);

  // List subfolders
  console.log('Listing episode folders...');
  const folders = await listSubfolders(drive, audioFolderId);
  console.log(`Found ${folders.length} folders.\n`);

  if (listOnly) {
    console.log('Folders in "Audio Files":');
    folders.forEach(f => console.log(`  - ${f.name}`));
    return;
  }

  // Get episodes to download
  const missingEpisodes = episodeOverrides
    ? getEpisodesByNumber(episodeOverrides)
    : missingMp3sMode
      ? getEpisodesMissingMp3s()
      : getEpisodesMissingTranscripts();

  if (episodeOverrides) {
    console.log(`Using explicit episode list (${missingEpisodes.length} found).\n`);
  } else if (missingMp3sMode) {
    console.log(`${missingEpisodes.length} episodes missing MP3 files.\n`);
  } else {
    console.log(`${missingEpisodes.length} episodes missing transcripts.\n`);
  }

  if (verbose) {
    console.log('Missing episodes:');
    missingEpisodes.slice(0, 20).forEach(ep => console.log(`  - E${ep.episode}: ${ep.film}`));
    if (missingEpisodes.length > 20) console.log(`  ... and ${missingEpisodes.length - 20} more\n`);
  }

  // "Best of" episodes must match via container folder probing, not regular folder matching
  // (otherwise they incorrectly match to the original episode's folder)
  const BEST_OF_PATTERN = /best\s*of/i;
  const regularEpisodes = missingEpisodes.filter(ep => !BEST_OF_PATTERN.test(ep.film));
  const bestOfEpisodes = missingEpisodes.filter(ep => BEST_OF_PATTERN.test(ep.film));

  // Match folders to regular (non-Best-Of) episodes
  const matches: Array<{ folder: DriveFolder; episode: EpisodeMissing }> = [];
  const unmatched: DriveFolder[] = [];

  for (const folder of folders) {
    const match = matchFolderToEpisode(folder.name, regularEpisodes);
    if (match) {
      matches.push({ folder, episode: match });
    } else {
      unmatched.push(folder);
    }
  }

  console.log(`Matched ${matches.length} folders to missing episodes.`);

  // Second pass: probe inside container folders for individual MP3 files
  // that match unresolved episodes (handles "Best Of" folder and similar containers)
  const matchedEpisodes = new Set(matches.map(m => m.episode.episode));
  const unmatchedEpisodes = [
    ...regularEpisodes.filter(ep => !matchedEpisodes.has(ep.episode)),
    ...bestOfEpisodes,
  ];

  // fileMatches: episode → { fileId, fileName, folderName }
  const fileMatches: Array<{ episode: EpisodeMissing; fileId: string; fileName: string; folderName: string }> = [];

  if (unmatchedEpisodes.length > 0) {
    // Only probe folders that look like multi-episode containers
    // (not matched to any single episode). Known containers: "Best Of", "Bonus", "Andor"
    const CONTAINER_PATTERNS = /^(best\s*of|bonus|andor|specials?|extras?|live\s*shows?)$/i;
    const foldersToProbe = unmatched.filter(f => CONTAINER_PATTERNS.test(f.name.trim()));

    if (foldersToProbe.length > 0) {
      console.log(`\nProbing ${foldersToProbe.length} container folder(s): ${foldersToProbe.map(f => f.name).join(', ')}`);
    }

    // For file-level matching, also strip "escape hatch" from episode names
    // so "Best of The Matrix" can match "Best of Escape Hatch: The Matrix"
    const containerEpisodes = unmatchedEpisodes.map(ep => ({
      ...ep,
      film: ep.film.replace(/escape\s*hatch\s*:?\s*/gi, ''),
    }));

    for (const folder of foldersToProbe) {
      if (unmatchedEpisodes.length === 0) break;
      const files = await listFilesInFolder(drive, folder.id);
      const mp3Files = files.filter(f => f.name.toLowerCase().endsWith('.mp3'));

      for (const mp3 of mp3Files) {
        const cleanedName = mp3.name
          .replace(/\s*-\s*FINAL\.mp3$/i, '')
          .replace(/\.mp3$/i, '')
          .replace(/escape\s*hatch\s*/gi, '');
        const match = matchFolderToEpisode(cleanedName, containerEpisodes);
        if (match) {
          // Find the original episode (with original film name) by episode number
          const originalEp = unmatchedEpisodes.find(e => e.episode === match.episode)!;
          fileMatches.push({ episode: originalEp, fileId: mp3.id, fileName: mp3.name, folderName: folder.name });
          // Remove from both lists
          const idx = unmatchedEpisodes.findIndex(e => e.episode === match.episode);
          if (idx !== -1) unmatchedEpisodes.splice(idx, 1);
          const cIdx = containerEpisodes.findIndex(e => e.episode === match.episode);
          if (cIdx !== -1) containerEpisodes.splice(cIdx, 1);
        }
      }
    }

    if (fileMatches.length > 0) {
      console.log(`Matched ${fileMatches.length} file(s) from container folders.`);
    }
  }

  if (unmatched.length > 0 && verbose) {
    console.log(`\nUnmatched folders (${unmatched.length}):`);
    unmatched.slice(0, 10).forEach(f => console.log(`  - ${f.name}`));
    if (unmatched.length > 10) console.log(`  ... and ${unmatched.length - 10} more`);
  }

  // Report episodes that never found audio, with the closest folder names.
  // This is the signal that a sheet Film title has a typo. The write/delete
  // of unresolved-episodes.json is skipped in dry-run mode — a dry run must
  // not have side effects on the workspace — but the console reporting still
  // runs so `--dry-run` shows what it *would* report.
  if (unmatchedEpisodes.length > 0) {
    const allFolderNames = folders.map(f => f.name);
    const unresolved: UnresolvedEpisode[] = unmatchedEpisodes.map(ep => ({
      episode: String(ep.episode),
      film: ep.film,
      suggestions: suggestFolders(ep.film, allFolderNames),
    }));

    if (!dryRun) {
      const reportPath = path.resolve(__dirname, '..', 'unresolved-episodes.json');
      fs.writeFileSync(reportPath, JSON.stringify(unresolved, null, 2));
      console.log(`\nWrote ${unresolved.length} unresolved episode(s) to ${reportPath}`);
    } else {
      console.log(`\n${unresolved.length} unresolved episode(s) (dry run — not writing report):`);
    }

    for (const u of unresolved) {
      const hint = u.suggestions.length > 0 ? ` — closest folders: ${u.suggestions.join(', ')}` : '';
      console.log(`  E${u.episode}: ${u.film} — no audio found${hint}`);
    }
  } else if (!dryRun) {
    // Clean up any stale report from a previous run
    const reportPath = path.resolve(__dirname, '..', 'unresolved-episodes.json');
    if (fs.existsSync(reportPath)) {
      fs.unlinkSync(reportPath);
    }
  }

  console.log('\nMatches:');
  matches.forEach(m => console.log(`  ${m.folder.name} → E${m.episode.episode}: ${m.episode.film}`));
  fileMatches.forEach(m => console.log(`  ${m.folderName}/${m.fileName} → E${m.episode.episode}: ${m.episode.film}`));

  if (dryRun) {
    console.log('\nDry run complete. Use without --dry-run to download.');
    return;
  }

  // Download MP3s
  console.log('\nDownloading MP3 files...\n');

  let downloaded = 0;
  let skipped = 0;
  let errors = 0;

  for (const { folder, episode } of matches) {
    const destPath = path.join(MP3_DIR, `${episode.episode}.mp3`);

    // Check if already exists
    if (fs.existsSync(destPath)) {
      console.log(`  SKIP: E${episode.episode} - already exists`);
      skipped++;
      continue;
    }

    // Find MP3 in folder
    const files = await listFilesInFolder(drive, folder.id);
    const mp3 = files.find(f => f.name.toLowerCase().endsWith('.mp3'));

    if (!mp3) {
      console.log(`  WARN: E${episode.episode} - no MP3 found in folder "${folder.name}"`);
      errors++;
      continue;
    }

    try {
      console.log(`  Downloading E${episode.episode}: ${mp3.name}...`);
      await downloadFile(drive, mp3.id, destPath);
      console.log(`    → Saved to ${destPath}`);
      downloaded++;
    } catch (err) {
      console.error(`  ERROR: E${episode.episode} - ${err}`);
      errors++;
    }
  }

  // Download file matches (from container folders like "Best Of")
  for (const { episode, fileId, fileName, folderName } of fileMatches) {
    const destPath = path.join(MP3_DIR, `${episode.episode}.mp3`);

    if (fs.existsSync(destPath)) {
      console.log(`  SKIP: E${episode.episode} - already exists`);
      skipped++;
      continue;
    }

    try {
      console.log(`  Downloading E${episode.episode}: ${folderName}/${fileName}...`);
      await downloadFile(drive, fileId, destPath);
      console.log(`    → Saved to ${destPath}`);
      downloaded++;
    } catch (err) {
      console.error(`  ERROR: E${episode.episode} - ${err}`);
      errors++;
    }
  }

  // RSS fallback: any episode in the input list that still has no local MP3
  // gets a chance to be served from the podcast's public RSS feed (Anchor.fm).
  // Match strategy is title-based since the feed's <title> equals the metadata
  // `film` field verbatim.
  const stillMissing = missingEpisodes.filter(
    ep => !fs.existsSync(path.join(MP3_DIR, `${ep.episode}.mp3`)),
  );
  let rssDownloaded = 0;
  let rssNotFound = 0;
  let rssErrors = 0;

  if (stillMissing.length > 0) {
    console.log(
      `\nDrive could not serve ${stillMissing.length} episode(s); trying RSS fallback (${getFeedUrl()})...`,
    );
    let feed: PodcastFeedItem[] | null = null;
    try {
      feed = await fetchPodcastFeed();
      console.log(`  Loaded ${feed.length} item(s) from feed.`);
    } catch (err) {
      console.error(`  ERROR: could not fetch RSS feed - ${err}`);
    }

    if (feed) {
      for (const ep of stillMissing) {
        const item = findItemByFilm(feed, ep.film);
        if (!item) {
          console.log(`  MISS: E${ep.episode} - no RSS item matched "${ep.film}"`);
          rssNotFound++;
          continue;
        }
        const destPath = path.join(MP3_DIR, `${ep.episode}.mp3`);
        try {
          console.log(`  Downloading E${ep.episode} from RSS: ${item.title}`);
          await downloadEnclosureToFile(item.enclosureUrl, destPath);
          console.log(`    → Saved to ${destPath} (source: rss)`);
          rssDownloaded++;
          errors--; // un-count: Drive had logged this as an error earlier
        } catch (err) {
          console.error(`  ERROR: E${ep.episode} (rss) - ${err}`);
          rssErrors++;
        }
      }
    } else {
      rssErrors = stillMissing.length;
    }
  }

  const totalDownloaded = downloaded + rssDownloaded;
  console.log(
    `\nComplete: ${totalDownloaded} downloaded (${downloaded} drive, ${rssDownloaded} rss), ` +
      `${skipped} skipped, ${Math.max(0, errors) + rssErrors} errors` +
      (rssNotFound > 0 ? `, ${rssNotFound} not found in either source` : '') +
      '.',
  );
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
