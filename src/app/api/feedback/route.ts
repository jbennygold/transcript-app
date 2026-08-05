import { NextRequest, NextResponse } from 'next/server';
import { put, list } from '@vercel/blob';
import { Resend } from 'resend';
import { fetchBlobJson, MUTABLE_BLOB_CACHE_MAX_AGE } from '@/lib/blob-storage';
import type { QueryLogEntry } from '@/lib/query-logger';

interface FeedbackEntry {
  id: string;
  timestamp: string;
  name: string;
  query: string;
  answer: string;
  rating: 'good' | 'bad';
  comment?: string;
  queryType?: string;
  source?: string;
  shareUrl?: string;
  queryLogId?: string;
}

let resendClient: Resend | null = null;

function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) {
    return null;
  }
  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

const FEEDBACK_EMAIL = process.env.FEEDBACK_EMAIL || 'delivered@resend.dev';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, query, answer, rating, comment, queryType, source, shareUrl, queryLogId } = body;

    if (!name || typeof name !== 'string' || name.trim() === '') {
      return NextResponse.json(
        { error: 'Name is required' },
        { status: 400 }
      );
    }

    if (!query || typeof query !== 'string') {
      return NextResponse.json(
        { error: 'Query is required' },
        { status: 400 }
      );
    }

    if (!rating || (rating !== 'good' && rating !== 'bad')) {
      return NextResponse.json(
        { error: 'Rating must be "good" or "bad"' },
        { status: 400 }
      );
    }

    if (!answer || typeof answer !== 'string') {
      return NextResponse.json(
        { error: 'Answer is required' },
        { status: 400 }
      );
    }

    const entry: FeedbackEntry = {
      id: `fb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      name: name.trim(),
      query,
      answer,
      rating,
      comment: comment?.trim() || undefined,
      queryType,
      source: source?.trim() || undefined,
      shareUrl: shareUrl?.trim() || undefined,
      queryLogId: queryLogId || undefined,
    };

    // Log to console (always visible in Vercel function logs)
    console.log('=== NEW FEEDBACK ===');
    console.log(JSON.stringify(entry, null, 2));
    console.log('====================');

    // Persist to Vercel Blob for offline analysis
    const month = entry.timestamp.slice(0, 7); // "2026-02"
    try {
      await put(`feedback-log/${month}/${entry.id}.json`, JSON.stringify(entry), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
      });
    } catch (blobError) {
      console.error('Failed to persist feedback to Blob:', blobError);
      // Don't fail the request if Blob write fails
    }

    // Write rating back to query log entry (fire-and-forget)
    if (queryLogId && typeof queryLogId === 'string' && queryLogId.startsWith('ql_')) {
      try {
        // Derive month from the base36 timestamp in the ID: ql_{base36_ts}_{random}
        const tsBase36 = queryLogId.split('_')[1];
        const tsMs = parseInt(tsBase36, 36);
        const logDate = new Date(tsMs);
        const logMonth = `${logDate.getFullYear()}-${String(logDate.getMonth() + 1).padStart(2, '0')}`;
        const logPathname = `query-log/${logMonth}/${queryLogId}.json`;

        // Fetch, merge, re-upload. The read must be size-verified: this is a
        // read-modify-write, so a stale CDN copy would be merged and written
        // back, dropping any field added since — classify-query-logs sets
        // useCaseLLM on these same entries.
        const logBlobs = await list({ prefix: logPathname });
        if (logBlobs.blobs.length > 0) {
          const blob = logBlobs.blobs[0];
          const loaded = await fetchBlobJson<QueryLogEntry>(blob.url, blob.size, 'fast');
          if (loaded) {
            const logEntry = loaded.data;
            logEntry.rating = rating;
            if (comment?.trim()) logEntry.comment = comment.trim();
            await put(logPathname, JSON.stringify(logEntry), {
              access: 'public',
              contentType: 'application/json',
              addRandomSuffix: false,
              allowOverwrite: true,
              cacheControlMaxAge: MUTABLE_BLOB_CACHE_MAX_AGE,
            });
          }
        }
      } catch (linkErr) {
        console.error('Failed to link feedback to query log:', linkErr);
      }
    }

    // Send email notification
    const resend = getResend();
    if (resend) {
      const ratingEmoji = rating === 'good' ? '+' : '-';
      const ratingText = rating === 'good' ? 'Good Answer' : 'Needs Work';

      const emailHtml = `
        <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: ${rating === 'good' ? '#16a34a' : '#dc2626'};">
            ${ratingEmoji} ${ratingText}
          </h2>

          <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-weight: 600; width: 120px;">From:</td>
              <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${entry.name}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-weight: 600;">Query:</td>
              <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${entry.query}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-weight: 600;">Query Type:</td>
              <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${entry.queryType || 'unknown'}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-weight: 600;">Time:</td>
              <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${new Date(entry.timestamp).toLocaleString()}</td>
            </tr>
          </table>

          <div style="margin-top: 20px;">
              <h3 style="margin-bottom: 8px;">Answer Given:</h3>
              <div style="background: #f9fafb; padding: 12px; border-radius: 8px; border: 1px solid #e5e7eb; max-height: 400px; overflow-y: auto; white-space: pre-wrap; font-size: 14px;">
                ${entry.answer}
              </div>
            </div>

          ${entry.comment ? `
            <div style="margin-top: 20px;">
              <h3 style="margin-bottom: 8px;">User Comments:</h3>
              <p style="background: #fef3c7; padding: 12px; border-radius: 8px; margin: 0; border: 1px solid #fcd34d;">
                ${entry.comment}
              </p>
            </div>
          ` : ''}

          <p style="color: #6b7280; font-size: 12px; margin-top: 30px;">
            Feedback ID: ${entry.id}
          </p>
        </div>
      `;

      try {
        await resend.emails.send({
          from: 'Escape Hatch Feedback <onboarding@resend.dev>',
          to: FEEDBACK_EMAIL,
          subject: `${ratingEmoji} Feedback: "${entry.query.slice(0, 50)}${entry.query.length > 50 ? '...' : ''}"`,
          html: emailHtml,
        });
        console.log('Feedback email sent successfully');
      } catch (emailError) {
        console.error('Failed to send feedback email:', emailError);
        // Don't fail the request if email fails - feedback is still logged
      }
    } else {
      console.warn('RESEND_API_KEY not configured - email not sent');
    }

    return NextResponse.json({ success: true, id: entry.id });
  } catch (error) {
    console.error('Feedback submission error:', error);
    return NextResponse.json(
      { error: 'Failed to submit feedback' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  const token = process.env.FEEDBACK_API_TOKEN;
  if (token) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${token}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const { searchParams } = new URL(request.url);
  const month = searchParams.get('month'); // e.g. "2026-02"
  const ratingFilter = searchParams.get('rating'); // "good" | "bad"
  const sourceFilter = searchParams.get('source'); // e.g. "discord"

  try {
    const prefix = month ? `feedback-log/${month}/` : 'feedback-log/';
    const { blobs } = await list({ prefix });

    const entries = await Promise.all(
      blobs.map(async (blob) => {
        try {
          const res = await fetch(blob.url);
          return (await res.json()) as FeedbackEntry;
        } catch {
          return null;
        }
      })
    );

    let results = entries.filter((e): e is FeedbackEntry => e !== null);
    if (ratingFilter === 'good' || ratingFilter === 'bad') {
      results = results.filter((e) => e.rating === ratingFilter);
    }
    if (sourceFilter) {
      results = results.filter((e) => e.source === sourceFilter);
    }

    results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return NextResponse.json({ count: results.length, entries: results });
  } catch (error) {
    console.error('Feedback list error:', error);
    return NextResponse.json({ error: 'Failed to list feedback' }, { status: 500 });
  }
}
