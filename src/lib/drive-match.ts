/**
 * Fuzzy matching between Google Drive folder names and sheet film titles.
 *
 * Extracted from scripts/download-drive-audio.ts so the scoring can be unit
 * tested and reused to suggest near-misses when a title does not match.
 */

export interface UnresolvedEpisode {
  episode: string;
  film: string;
  suggestions: string[];
}

/** Minimum score download-drive-audio accepts as a real match. */
export const MATCH_THRESHOLD = 50;

/**
 * Lowest score worth showing a human as a possible near-miss.
 *
 * Only gates the typo path: scoreFolderAgainstFilm returns either 0 or >= 68,
 * so no real match score falls in the filtered band.
 */
const SUGGESTION_THRESHOLD = 60;

export function normalizeFolderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\b(the|a|an)\b/g, '')
    .replace(/\(\d{4}\)/g, '')
    .replace(/\d{4}$/g, '')
    .replace(/bonus\s*/gi, '')
    .replace(/episode\s*\d+\s*:?\s*/gi, '')
    .replace(/best\s*of\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractYear(name: string): number | null {
  const match = name.match(/\((\d{4})\)|\b(19\d{2}|20\d{2})\b/);
  return match ? parseInt(match[1] || match[2], 10) : null;
}

/**
 * Score how well a Drive folder name matches a film title.
 * 0 means no match; >= MATCH_THRESHOLD is accepted as a real match.
 */
export function scoreFolderAgainstFilm(folderName: string, film: string): number {
  const normalizedFolder = normalizeFolderName(folderName);
  const normalizedFilm = normalizeFolderName(film);
  const folderYear = extractYear(folderName);
  const filmYear = extractYear(film);

  let score = 0;

  if (normalizedFolder === normalizedFilm) {
    score = 100;
  } else if (normalizedFolder.length >= 4 && normalizedFilm.length >= 4) {
    if (
      normalizedFolder.includes(normalizedFilm) &&
      normalizedFilm.length >= normalizedFolder.length * 0.5
    ) {
      score = 80;
    } else if (
      normalizedFilm.includes(normalizedFolder) &&
      normalizedFolder.length >= normalizedFilm.length * 0.5
    ) {
      score = 80;
    }
  }

  if (score === 0) {
    const folderWords = normalizedFolder.split(' ').filter(w => w.length > 2);
    const filmWords = normalizedFilm.split(' ').filter(w => w.length > 2);

    if (folderWords.length > 0 && filmWords.length > 0) {
      const matchingWords = folderWords.filter(w =>
        filmWords.some(fw => {
          if (fw === w) return true;
          const shorter = w.length < fw.length ? w : fw;
          if (shorter.length < 5) return false;
          return fw.includes(w) || w.includes(fw);
        })
      );
      const matchRatio = matchingWords.length / Math.max(folderWords.length, filmWords.length);
      const minMatchingWords = Math.min(2, Math.min(folderWords.length, filmWords.length));
      if (matchRatio >= 0.6 && matchingWords.length >= minMatchingWords) {
        score = 50 + matchRatio * 30;
      }
    }
  }

  if (score > 0 && folderYear && filmYear) {
    if (folderYear === filmYear) score += 10;
    else score = 0;
  }

  return score;
}

/** Levenshtein edit distance, two-row variant. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/** 0..1 similarity between two names. 1 is identical. */
export function nameSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - editDistance(a, b) / maxLen;
}

/**
 * Folder names that came closest to a film title without clearing the match
 * threshold — the candidates a human should look at when audio is missing.
 *
 * Word-overlap scoring alone cannot see a typo: "Sorceror" and "Sorcerer"
 * share no whole word, so scoreFolderAgainstFilm rates them 0. Suggestions
 * therefore take the better of the match score and an edit-distance score,
 * because a misspelled title is the most common reason audio goes unfound.
 */
export function suggestFolders(film: string, folderNames: string[], limit = 3): string[] {
  const normalizedFilm = normalizeFolderName(film);
  return folderNames
    .map(name => ({
      name,
      score: Math.max(
        scoreFolderAgainstFilm(name, film),
        nameSimilarity(normalizeFolderName(name), normalizedFilm) * 100
      ),
    }))
    .filter(entry => entry.score >= SUGGESTION_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(entry => entry.name);
}
