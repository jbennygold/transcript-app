/**
 * Upload vector store and BM25 index to Vercel Blob storage.
 * This allows us to stay under the 250MB serverless function limit
 * by loading data at runtime instead of bundling it.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { put } from '@vercel/blob';

dotenv.config({ path: '.env.local' });

const SEARCH_DATA_PREFIX = 'search-data/';

async function uploadSearchData() {
  console.log('Uploading search data to Vercel Blob...\n');

  const vectorStorePath = path.join(process.cwd(), 'vector-store.json');
  const bm25IndexPath = path.join(process.cwd(), 'bm25-index.json');

  // Upload vector store
  if (fs.existsSync(vectorStorePath)) {
    const vectorStoreData = fs.readFileSync(vectorStorePath, 'utf-8');
    const sizeInMB = (Buffer.byteLength(vectorStoreData, 'utf-8') / (1024 * 1024)).toFixed(2);
    console.log(`Uploading vector-store.json (${sizeInMB} MB)...`);

    const blob = await put(`${SEARCH_DATA_PREFIX}vector-store.json`, vectorStoreData, {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    console.log(`  ✓ Uploaded to: ${blob.url}`);
  } else {
    console.log('Warning: vector-store.json not found, skipping upload');
  }

  // Upload BM25 index
  if (fs.existsSync(bm25IndexPath)) {
    const bm25Data = fs.readFileSync(bm25IndexPath, 'utf-8');
    const sizeInMB = (Buffer.byteLength(bm25Data, 'utf-8') / (1024 * 1024)).toFixed(2);
    console.log(`Uploading bm25-index.json (${sizeInMB} MB)...`);

    const blob = await put(`${SEARCH_DATA_PREFIX}bm25-index.json`, bm25Data, {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    console.log(`  ✓ Uploaded to: ${blob.url}`);
  } else {
    console.log('Warning: bm25-index.json not found, skipping upload');
  }

  // Upload topic vectors
  const topicVectorsPath = path.join(process.cwd(), 'topic-vectors.json');
  if (fs.existsSync(topicVectorsPath)) {
    const topicData = fs.readFileSync(topicVectorsPath, 'utf-8');
    const sizeInMB = (Buffer.byteLength(topicData, 'utf-8') / (1024 * 1024)).toFixed(2);
    console.log(`Uploading topic-vectors.json (${sizeInMB} MB)...`);

    const blob = await put(`${SEARCH_DATA_PREFIX}topic-vectors.json`, topicData, {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    console.log(`  ✓ Uploaded to: ${blob.url}`);
  } else {
    console.log('Note: topic-vectors.json not found, skipping upload');
  }

  // Upload playlist data
  const playlistDataPath = path.join(process.cwd(), 'playlist-data.json');
  if (fs.existsSync(playlistDataPath)) {
    const playlistData = fs.readFileSync(playlistDataPath, 'utf-8');
    const sizeInMB = (Buffer.byteLength(playlistData, 'utf-8') / (1024 * 1024)).toFixed(2);
    console.log(`Uploading playlist-data.json (${sizeInMB} MB)...`);

    const blob = await put(`${SEARCH_DATA_PREFIX}playlist-data.json`, playlistData, {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    console.log(`  ✓ Uploaded to: ${blob.url}`);
  } else {
    console.log('Note: playlist-data.json not found, skipping upload');
  }

  // Upload the LLM-extraction caches (content-hash keyed). Persisting these to
  // Blob is what keeps the next ingest from re-paying full Haiku cost — a cold
  // topic/playlist cache costs ~$20/full pass. Restored by download-search-data.
  for (const cacheFile of ['topic-cache.json', 'playlist-cache.json']) {
    const cachePath = path.join(process.cwd(), cacheFile);
    if (fs.existsSync(cachePath)) {
      const cacheData = fs.readFileSync(cachePath, 'utf-8');
      const sizeInMB = (Buffer.byteLength(cacheData, 'utf-8') / (1024 * 1024)).toFixed(2);
      console.log(`Uploading ${cacheFile} (${sizeInMB} MB)...`);

      const blob = await put(`${SEARCH_DATA_PREFIX}${cacheFile}`, cacheData, {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      console.log(`  ✓ Uploaded to: ${blob.url}`);
    } else {
      console.log(`Note: ${cacheFile} not found, skipping upload`);
    }
  }

  console.log('\n✓ Search data upload complete!');
}

uploadSearchData().catch((error) => {
  console.error('Failed to upload search data:', error);
  process.exit(1);
});
