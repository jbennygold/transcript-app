#!/usr/bin/env node
/**
 * sync-legacy-metadata-json.ts — Writes data/episode-metadata.json from the
 * canonical src/lib/metadata-data.ts export, so external consumers that still
 * fetch the raw JSON file stay in sync. Invoked at the end of each metadata
 * sync workflow, before the git commit.
 */

import * as fs from 'fs';
import * as path from 'path';
import { episodeMetadata } from '../src/lib/metadata-data';

const out = path.join(process.cwd(), 'data', 'episode-metadata.json');
fs.writeFileSync(out, JSON.stringify(episodeMetadata, null, 2) + '\n');
console.log(`Wrote ${episodeMetadata.length} episodes to ${out}`);
