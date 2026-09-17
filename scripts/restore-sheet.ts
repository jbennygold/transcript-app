/**
 * Rebuild the PDC Google Sheet from data/sheet-backup (see snapshot-sheet.ts).
 *
 *   npm run restore-sheet                       # creates a NEW spreadsheet owned by the service account
 *   npm run restore-sheet -- --to <spreadsheetId>  # writes into an existing spreadsheet you own
 *   npm run restore-sheet -- --dir <backupDir>
 *
 * Tabs are created in manifest order with their original grid sizes, then the
 * formulas CSV is written with USER_ENTERED so formulas re-evaluate and cross-tab
 * references resolve by tab name. Formatting, notes, validation and charts are not
 * part of the snapshot and are not restored.
 *
 * With --to, the target must be shared with the service account as Editor. Existing
 * tabs with matching titles are cleared and overwritten; other tabs are left alone.
 * A new spreadsheet is owned by the service account: open it via the printed URL
 * after sharing, or transfer ownership from the service account's Drive.
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import fs from 'fs';
import path from 'path';
import { google, sheets_v4 } from 'googleapis';
import { fromCsv, SnapshotManifest } from '../src/lib/sheet-snapshot';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const BACKUP_DIR = path.resolve(process.cwd(), arg('--dir') ?? 'data/sheet-backup');
const TARGET_ID = arg('--to');

function getSheetsClient() {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (!keyFile) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_FILE is required');
  const keyPath = path.resolve(process.cwd(), keyFile);
  if (!fs.existsSync(keyPath)) throw new Error(`Service account key file not found: ${keyPath}`);
  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

function serviceAccountEmail(): string | null {
  try {
    const keyPath = path.resolve(process.cwd(), process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ?? '');
    return (JSON.parse(fs.readFileSync(keyPath, 'utf-8')) as { client_email?: string }).client_email ?? null;
  } catch {
    return null;
  }
}

function quoteRange(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function readManifest(): SnapshotManifest {
  const file = path.join(BACKUP_DIR, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error(`No manifest at ${file}. Run snapshot-sheet first.`);
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as SnapshotManifest;
}

async function ensureTabs(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  manifest: SnapshotManifest
): Promise<void> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(title))' });
  const existing = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title ?? ''));

  const requests: sheets_v4.Schema$Request[] = manifest.tabs
    .filter((tab) => !existing.has(tab.title))
    .map((tab) => ({
      addSheet: {
        properties: {
          title: tab.title,
          gridProperties: { rowCount: Math.max(tab.rowCount, 1), columnCount: Math.max(tab.columnCount, 1) },
        },
      },
    }));

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  }
}

async function main() {
  const sheets = getSheetsClient();
  const manifest = readManifest();

  let spreadsheetId = TARGET_ID;
  let created = false;

  if (!spreadsheetId) {
    const title = `PDC restore ${new Date().toISOString().slice(0, 10)}`;
    let res;
    try {
      res = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title },
        sheets: manifest.tabs.map((tab) => ({
          properties: {
            title: tab.title,
            index: tab.index,
            gridProperties: { rowCount: Math.max(tab.rowCount, 1), columnCount: Math.max(tab.columnCount, 1) },
          },
        })),
      },
      });
    } catch (error) {
      // Service accounts usually cannot own Drive files, so creation is denied.
      // The reliable path is to restore into a sheet the user owns.
      const email = serviceAccountEmail();
      throw new Error(
        `Could not create a new spreadsheet (${error instanceof Error ? error.message : error}).\n` +
          `Create a blank Google Sheet yourself, share it as Editor with ${email ?? 'the service account'}, ` +
          `then run: npm run restore-sheet -- --to <thatSpreadsheetId>`
      );
    }
    spreadsheetId = res.data.spreadsheetId!;
    created = true;
    console.log(`Created spreadsheet "${title}" (${spreadsheetId})`);
  } else {
    await ensureTabs(sheets, spreadsheetId, manifest);
  }

  for (const tab of manifest.tabs) {
    const file = path.join(BACKUP_DIR, `${tab.stem}.formulas.csv`);
    if (!fs.existsSync(file)) {
      console.warn(`  skipping ${tab.title}: ${file} missing`);
      continue;
    }
    const rows = fromCsv(fs.readFileSync(file, 'utf-8'));
    const range = quoteRange(tab.title);

    if (!created) {
      await sheets.spreadsheets.values.clear({ spreadsheetId, range });
    }
    if (rows.length === 0) {
      console.log(`  ${tab.title}: empty`);
      continue;
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${range}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    });
    console.log(`  ${tab.title}: ${rows.length} rows written`);
  }

  console.log(`Done: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
}

main().catch((error) => {
  console.error('Restore failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
