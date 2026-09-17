/**
 * Lossless text snapshot of a Google Sheet: every tab as a values CSV and a
 * formulas CSV, plus a manifest. Pure helpers live here so they can be tested;
 * the Sheets API calls live in scripts/snapshot-sheet.ts and scripts/restore-sheet.ts.
 */

export interface TabInfo {
  title: string;
  sheetId: number;
  index: number;
  rowCount: number;
  columnCount: number;
}

export interface ManifestTab extends TabInfo {
  /** File stem for `<stem>.values.csv` and `<stem>.formulas.csv`. */
  stem: string;
}

export interface SnapshotManifest {
  spreadsheetId: string;
  tabs: ManifestTab[];
}

/** Sheets API cells can be numbers, booleans or null; a CSV wants strings. */
export function normalizeGrid(grid: unknown[][]): string[][] {
  return grid.map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))));
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** RFC 4180: CRLF row terminators, quote only when needed, ragged rows kept as-is. */
export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvField).join(',') + '\r\n').join('');
}

/** Inverse of toCsv. Handles quoted fields with embedded commas, quotes and newlines. */
export function fromCsv(text: string): string[][] {
  const rows: string[][] = [];
  if (text.length === 0) return rows;

  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          quoted = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i++;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  // Trailing row without a terminator.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Lowercase, alphanumerics only, hyphen-separated. Stable across runs. */
export function tabFileStem(title: string): string {
  return title
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildManifest(spreadsheetId: string, tabs: TabInfo[]): SnapshotManifest {
  const seen = new Map<string, string>();
  const manifestTabs = tabs.map((tab) => {
    const stem = tabFileStem(tab.title);
    const clash = seen.get(stem);
    if (clash !== undefined) {
      throw new Error(`Tabs "${clash}" and "${tab.title}" both map to file stem "${stem}"`);
    }
    seen.set(stem, tab.title);
    return { ...tab, stem };
  });
  return { spreadsheetId, tabs: manifestTabs };
}
