/**
 * Read/write access to the canonical Pod Data Central Google Sheet.
 *
 * Pure helpers (mapHeaders, mergeRow, findRowIndexByEpisode, buildNewRow) are
 * separated from the Sheets I/O so they can be unit-tested without credentials.
 */
import { google } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';

export const SHEET_ID = '1RbtWP966CxA57PatyMcbJ6_ylg9tmCvDSLNxjmQ4bvk';
export const SHEET_TAB = 'Pod Data Detail';

export const PDC_COLUMN_KEYS = [
  'Pod', 'Season', 'Ep', 'Film', 'Release_Date', 'Length', 'Length_minutes',
  'Reviewer', 'Guest', 'MMM_Count', 'Thats_Great_Count', 'Notable_Moments',
  'H_Flex', 'J_Flex', 'Kevs_Question', 'TildaH', 'TildaJason', 'TildaGuest',
  'TildaCorey', 'Chuckle_Hut_Favorites', 'Show_Link', 'Artwork_Link',
  'Letterboxd_Link', 'IMDB_Link',
] as const;

export type PdcColumnKey = (typeof PDC_COLUMN_KEYS)[number];
export type PdcRow = Partial<Record<PdcColumnKey, string>>;
export type WriteMode = 'fill-empty' | 'overwrite';

export interface UpsertResult {
  action: 'inserted' | 'updated' | 'no_change' | 'skipped_no_row';
  changedFields: string[];
}

/** A validation failure whose message is safe to surface to the caller verbatim. */
export class PdcSheetValidationError extends Error {}

/** Header spellings the sheet has used over time, canonical form first. */
export const HEADER_ALIASES: Partial<Record<PdcColumnKey, string[]>> = {
  Ep: ['Ep', 'Episode'],
  Release_Date: ['Release_Date', 'Release Date', 'Timestamp'],
  Length_minutes: ['Length_minutes', 'Length minutes'],
  MMM_Count: ['MMM_Count', 'MMM Count'],
  Thats_Great_Count: ['Thats_Great_Count', "That's Great Count", 'Thats Great Count'],
  Notable_Moments: ['Notable_Moments', 'Notable Moments'],
  H_Flex: ['H_Flex', 'H Flex'],
  J_Flex: ['J_Flex', 'J Flex'],
  Kevs_Question: ['Kevs_Question', "Kev's Question", 'Kevs Question'],
  TildaH: ['TildaH', 'Tilda H', 'H Tilda'],
  TildaJason: ['TildaJason', 'Tilda Jason', 'J Tilda'],
  TildaGuest: ['TildaGuest', 'Tilda Guest', 'Guest Tilda'],
  TildaCorey: ['TildaCorey', 'Tilda Corey', 'Corey Tilda'],
  Chuckle_Hut_Favorites: ['Chuckle_Hut_Favorites', 'Chuckle Hut Favorites'],
  Show_Link: ['Show_Link', 'Show Link'],
  Artwork_Link: ['Artwork_Link', 'Artwork Link'],
  Letterboxd_Link: ['Letterboxd_Link', 'Letterboxd Link'],
  IMDB_Link: ['IMDB_Link', 'IMDB Link'],
};

/** Map each canonical column key to its zero-based index in the sheet header row. */
export function mapHeaders(headerRow: string[]): Map<string, number> {
  const headerToCol = new Map<string, number>();
  for (const key of PDC_COLUMN_KEYS) {
    const aliases = HEADER_ALIASES[key] ?? [key];
    for (const alias of aliases) {
      const idx = headerRow.findIndex(h => String(h).trim() === alias);
      if (idx !== -1) {
        headerToCol.set(key, idx);
        break;
      }
    }
  }
  return headerToCol;
}

/**
 * Apply rowData onto a copy of existingRow.
 *
 * Blank incoming values are always skipped, so a write can never erase a cell.
 * In 'fill-empty' mode a cell that already holds a value is left alone.
 */
export function mergeRow(
  existingRow: string[],
  rowData: PdcRow,
  headerMap: Map<string, number>,
  mode: WriteMode
): { updatedRow: string[]; changedFields: string[] } {
  const indexes = Array.from(headerMap.values());
  const maxCol = indexes.length > 0 ? Math.max(...indexes) : -1;
  const updatedRow = [...existingRow];
  while (updatedRow.length <= maxCol) updatedRow.push('');

  const changedFields: string[] = [];
  for (const [key, colIdx] of headerMap) {
    const newVal = rowData[key as PdcColumnKey];
    if (newVal === undefined || newVal === null || newVal.trim() === '') continue;
    const oldVal = String(updatedRow[colIdx] ?? '').trim();
    if (mode === 'fill-empty' && oldVal !== '') continue;
    if (oldVal === newVal.trim()) continue;
    updatedRow[colIdx] = newVal;
    changedFields.push(key);
  }

  return { updatedRow, changedFields };
}

/** Index into `rows` of the row whose Ep cell equals `episode`, or -1. */
export function findRowIndexByEpisode(
  rows: string[][],
  epColIdx: number,
  episode: string
): number {
  const target = String(episode).trim().toLowerCase();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][epColIdx] ?? '').trim().toLowerCase() === target) return i;
  }
  return -1;
}

/** Build a full-width row for insertion, blank in every unmapped position. */
export function buildNewRow(rowData: PdcRow, headerMap: Map<string, number>): string[] {
  const indexes = Array.from(headerMap.values());
  const maxCol = indexes.length > 0 ? Math.max(...indexes) : -1;
  const newRow: string[] = new Array(maxCol + 1).fill('');
  for (const [key, colIdx] of headerMap) {
    newRow[colIdx] = rowData[key as PdcColumnKey] ?? '';
  }
  return newRow;
}

/**
 * Append one bullet to a Notable_Moments-style cell.
 *
 * Existing rows are newline-delimited "- " bullets, so appended notes match
 * that shape and searchNotableMoments() tokenisation keeps working. Older rows
 * are free prose; we append to them rather than reformatting what is there.
 *
 * Returns null when the line is blank or already present — the caller treats
 * that as a no-op, not an error.
 */
export function appendBullet(existing: string, line: string): string | null {
  const clean = String(line ?? '').trim().replace(/^-\s*/, '').trim();
  if (clean === '') return null;

  const current = String(existing ?? '');
  const already = current
    .split('\n')
    .map(l => l.replace(/^-\s*/, '').trim().toLowerCase())
    .some(l => l !== '' && l === clean.toLowerCase());
  if (already) return null;

  return current.trim() === '' ? `- ${clean}` : `${current.replace(/\s+$/, '')}\n- ${clean}`;
}

function getSheetsAuth() {
  const jsonKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
  if (jsonKey) {
    return new google.auth.GoogleAuth({
      credentials: JSON.parse(jsonKey),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (keyFile) {
    const keyPath = path.resolve(process.cwd(), keyFile);
    if (fs.existsSync(keyPath)) {
      return new google.auth.GoogleAuth({
        keyFile: keyPath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    }
  }

  return null;
}

export function hasSheetCredentials(): boolean {
  return getSheetsAuth() !== null;
}

/** Insert or update the row for `rowData.Ep`. Requires an Ep value. */
export async function upsertEpisodeRow(rowData: PdcRow, mode: WriteMode): Promise<UpsertResult> {
  const episode = rowData.Ep;
  if (!episode) throw new Error('upsertEpisodeRow requires an Ep value');

  const auth = getSheetsAuth();
  if (!auth) {
    const hasJson = !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
    const hasFile = !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
    throw new PdcSheetValidationError(
      `Google Sheets credentials not configured (JSON: ${hasJson}, FILE: ${hasFile})`
    );
  }

  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_TAB}'`,
  });

  const rows = (res.data.values as string[][] | undefined) ?? [];
  if (rows.length === 0) throw new PdcSheetValidationError('Sheet is empty or not found');

  const headerRow = rows[0].map(h => String(h).trim());
  const headerMap = mapHeaders(headerRow);
  const epColIdx = headerMap.get('Ep');
  if (epColIdx === undefined) throw new PdcSheetValidationError('Could not find Ep column in sheet');

  const matchRowIdx = findRowIndexByEpisode(rows, epColIdx, episode);

  if (matchRowIdx !== -1) {
    const { updatedRow, changedFields } = mergeRow(rows[matchRowIdx], rowData, headerMap, mode);
    if (changedFields.length === 0) return { action: 'no_change', changedFields: [] };

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_TAB}'!A${matchRowIdx + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [updatedRow] },
    });
    return { action: 'updated', changedFields };
  }

  // Tier 1 (fill-empty) fills rows a human already created; it must never
  // create one itself. Only the interactive 'overwrite' route (a human
  // deliberately adding a row via /podreview) may append. Without this
  // guard, sheet drift (a renumbered/deleted row, a zero-padded Ep) makes
  // --fill-gaps insert a junk row carrying only Ep + links — no Pod, Season,
  // Film, Reviewer — which then reads back through sync-metadata as a
  // permanently "new" episode with a blank film.
  if (mode === 'fill-empty') return { action: 'skipped_no_row', changedFields: [] };

  const newRow = buildNewRow(rowData, headerMap);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_TAB}'!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [newRow] },
  });

  return {
    action: 'inserted',
    changedFields: Object.keys(rowData).filter(k => (rowData[k as PdcColumnKey] ?? '') !== ''),
  };
}

/**
 * Append a bullet to one cell of an existing row.
 *
 * Never creates a row: an episode with no sheet row returns 'no_row'. This is
 * a read-modify-write of a single cell, so it writes only that cell rather than
 * the whole row.
 */
export async function appendToCell(
  episode: string,
  column: PdcColumnKey,
  line: string
): Promise<'appended' | 'duplicate' | 'no_row'> {
  const auth = getSheetsAuth();
  if (!auth) throw new PdcSheetValidationError('Google Sheets credentials not configured');

  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_TAB}'`,
  });

  const rows = (res.data.values as string[][] | undefined) ?? [];
  if (rows.length === 0) throw new PdcSheetValidationError('Sheet is empty or not found');

  const headerMap = mapHeaders(rows[0].map(h => String(h).trim()));
  const epColIdx = headerMap.get('Ep');
  if (epColIdx === undefined) throw new PdcSheetValidationError('Could not find Ep column in sheet');

  const colIdx = headerMap.get(column);
  if (colIdx === undefined) throw new PdcSheetValidationError(`Could not find ${column} column in sheet`);

  const rowIdx = findRowIndexByEpisode(rows, epColIdx, episode);
  if (rowIdx === -1) return 'no_row';

  const next = appendBullet(String(rows[rowIdx][colIdx] ?? ''), line);
  if (next === null) return 'duplicate';

  // Column index to A1 letter. The sheet has 24 columns, so one letter suffices,
  // but handle two just in case a column is added later.
  const a1 =
    colIdx < 26
      ? String.fromCharCode(65 + colIdx)
      : String.fromCharCode(64 + Math.floor(colIdx / 26)) + String.fromCharCode(65 + (colIdx % 26));

  // RAW, not USER_ENTERED: this column is prose fed by a Discord command open
  // to the channel. USER_ENTERED interprets the string as if typed into
  // Sheets, so a numeric-looking first note (e.g. "12345") lands as "- 12345"
  // and evaluates to -12345, destroying the note. upsertEpisodeRow is
  // unaffected — it writes links/dates that benefit from USER_ENTERED coercion.
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_TAB}'!${a1}${rowIdx + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[next]] },
  });

  return 'appended';
}
