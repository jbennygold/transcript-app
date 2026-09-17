/**
 * Lossless text snapshot of the canonical PDC Google Sheet, for disaster recovery.
 *
 * Writes, for every tab:
 *   data/sheet-backup/<stem>.values.csv    — what a human sees (formatted values)
 *   data/sheet-backup/<stem>.formulas.csv  — raw cell contents (formulas + literals); restore input
 * plus data/sheet-backup/manifest.json with tab order, ids and grid sizes.
 *
 * Auth: GOOGLE_SERVICE_ACCOUNT_KEY_FILE (same as sync-metadata). Read-only.
 * Restore with: npm run restore-sheet
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { SHEET_ID } from '../src/lib/pdc-sheet';
import { buildManifest, normalizeGrid, toCsv, TabInfo } from '../src/lib/sheet-snapshot';

const OUT_DIR = path.resolve(process.cwd(), process.argv[2] ?? 'data/sheet-backup');

function getSheetsClient() {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (!keyFile) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_FILE is required');
  const keyPath = path.resolve(process.cwd(), keyFile);
  if (!fs.existsSync(keyPath)) throw new Error(`Service account key file not found: ${keyPath}`);
  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

function quoteRange(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

async function main() {
  const sheets = getSheetsClient();

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: 'sheets(properties(title,sheetId,index,gridProperties(rowCount,columnCount)))',
  });

  const tabs: TabInfo[] = (meta.data.sheets ?? [])
    .map((s) => s.properties!)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((p) => ({
      title: p.title!,
      sheetId: p.sheetId!,
      index: p.index ?? 0,
      rowCount: p.gridProperties?.rowCount ?? 0,
      columnCount: p.gridProperties?.columnCount ?? 0,
    }));

  const manifest = buildManifest(SHEET_ID, tabs);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const keep = new Set<string>(['manifest.json']);
  for (const tab of manifest.tabs) {
    const range = quoteRange(tab.title);
    const [values, formulas] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range, valueRenderOption: 'FORMATTED_VALUE' }),
      sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range, valueRenderOption: 'FORMULA' }),
    ]);
    const valuesCsv = toCsv(normalizeGrid((values.data.values ?? []) as unknown[][]));
    const formulasCsv = toCsv(normalizeGrid((formulas.data.values ?? []) as unknown[][]));

    const vName = `${tab.stem}.values.csv`;
    const fName = `${tab.stem}.formulas.csv`;
    fs.writeFileSync(path.join(OUT_DIR, vName), valuesCsv);
    fs.writeFileSync(path.join(OUT_DIR, fName), formulasCsv);
    keep.add(vName);
    keep.add(fName);
    console.log(`  ${tab.title}: ${values.data.values?.length ?? 0} rows`);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // Drop files for tabs that were renamed or deleted so the backup mirrors the sheet.
  for (const file of fs.readdirSync(OUT_DIR)) {
    if (!keep.has(file) && /\.(values|formulas)\.csv$/.test(file)) {
      fs.unlinkSync(path.join(OUT_DIR, file));
      console.log(`  removed stale ${file}`);
    }
  }

  console.log(`Snapshot of ${manifest.tabs.length} tabs written to ${path.relative(process.cwd(), OUT_DIR)}`);
}

main().catch((error) => {
  console.error('Snapshot failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
