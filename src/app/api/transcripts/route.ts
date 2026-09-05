import { NextResponse } from 'next/server';
import { listBlobTranscripts, loadTranscriptByUrl, listBlobAudioEpisodes } from '@/lib/blob-storage';
import { buildTranscriptList } from '@/lib/transcript-list';

export async function GET() {
  try {
    const transcripts = await buildTranscriptList({
      listTranscripts: listBlobTranscripts,
      fetchTranscript: loadTranscriptByUrl,
      listAudioEpisodes: listBlobAudioEpisodes,
    });
    return NextResponse.json(transcripts);
  } catch {
    // Blob storage not available
    return NextResponse.json([]);
  }
}
