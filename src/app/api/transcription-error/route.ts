import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';

interface TranscriptionErrorReport {
  id: string;
  timestamp: string;
  episodeTitle: string;
  startTimestamp: string;
  endTimestamp: string;
  speakers: string;
  originalText: string;
  selectedText: string;
  correctedText: string;
  reporterName?: string;
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
    const {
      episodeTitle,
      episodeNumber: providedEpisodeNumber,
      startTimestamp,
      endTimestamp,
      speakers,
      originalText,
      selectedText,
      correctedText,
      reporterName,
    } = body;

    if (!episodeTitle || typeof episodeTitle !== 'string') {
      return NextResponse.json(
        { error: 'Episode title is required' },
        { status: 400 }
      );
    }

    if (!selectedText || typeof selectedText !== 'string') {
      return NextResponse.json(
        { error: 'Selected text is required' },
        { status: 400 }
      );
    }

    if (!correctedText || typeof correctedText !== 'string') {
      return NextResponse.json(
        { error: 'Corrected text is required' },
        { status: 400 }
      );
    }

    const report: TranscriptionErrorReport = {
      id: `te_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      episodeTitle,
      startTimestamp: startTimestamp || 'unknown',
      endTimestamp: endTimestamp || 'unknown',
      speakers: speakers || 'unknown',
      originalText: originalText || '',
      selectedText,
      correctedText,
      reporterName: reporterName?.trim() || undefined,
    };

    // Log to console
    console.log('=== TRANSCRIPTION ERROR REPORT ===');
    console.log(JSON.stringify(report, null, 2));
    console.log('==================================');

    // Send email notification
    const resend = getResend();
    if (resend) {
      // Use provided episode number, or try to extract from title (e.g., "Episode 119: Galaxy Quest" -> "119")
      let episodeNumber: string;
      if (providedEpisodeNumber !== undefined && providedEpisodeNumber !== null) {
        episodeNumber = String(providedEpisodeNumber);
      } else {
        const episodeMatch = episodeTitle.match(/Episode\s*(\d+)/i);
        episodeNumber = episodeMatch ? episodeMatch[1] : 'unknown';
      }

      const emailHtml = `
        <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #dc2626;">
            📝 Transcription Error Report
          </h2>

          <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-weight: 600; width: 140px;">Episode:</td>
              <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${report.episodeTitle}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-weight: 600;">Timestamp:</td>
              <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${report.startTimestamp} - ${report.endTimestamp}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-weight: 600;">Speakers:</td>
              <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${report.speakers}</td>
            </tr>
            ${report.reporterName ? `
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-weight: 600;">Reported by:</td>
              <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${report.reporterName}</td>
            </tr>
            ` : ''}
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-weight: 600;">Time:</td>
              <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${new Date(report.timestamp).toLocaleString()}</td>
            </tr>
          </table>

          <div style="margin-top: 20px;">
            <h3 style="margin-bottom: 8px; color: #dc2626;">❌ Incorrect Text:</h3>
            <div style="background: #fef2f2; padding: 12px; border-radius: 8px; border: 1px solid #fecaca; font-size: 14px;">
              ${report.selectedText}
            </div>
          </div>

          <div style="margin-top: 20px;">
            <h3 style="margin-bottom: 8px; color: #16a34a;">✓ Corrected Text:</h3>
            <div style="background: #f0fdf4; padding: 12px; border-radius: 8px; border: 1px solid #bbf7d0; font-size: 14px;">
              ${report.correctedText}
            </div>
          </div>

          ${report.originalText ? `
          <div style="margin-top: 20px;">
            <h3 style="margin-bottom: 8px; color: #6b7280;">Full Context:</h3>
            <div style="background: #f9fafb; padding: 12px; border-radius: 8px; border: 1px solid #e5e7eb; font-size: 12px; max-height: 200px; overflow-y: auto; white-space: pre-wrap;">
              ${report.originalText}
            </div>
          </div>
          ` : ''}

          <div style="margin-top: 30px; padding: 16px; background: #eff6ff; border-radius: 8px; border: 1px solid #bfdbfe;">
            <h4 style="margin: 0 0 8px 0; color: #1e40af;">To Fix:</h4>
            <ol style="margin: 0; padding-left: 20px; color: #1e40af; font-size: 14px;">
              <li>Open <code>transcripts/episode_${episodeNumber}.json</code></li>
              <li>Search for: <code>${report.selectedText.slice(0, 50)}${report.selectedText.length > 50 ? '...' : ''}</code></li>
              <li>Replace with the corrected text</li>
              <li>Commit, push, and redeploy to rebuild search index</li>
            </ol>
          </div>

          <p style="color: #6b7280; font-size: 12px; margin-top: 30px;">
            Report ID: ${report.id}
          </p>
        </div>
      `;

      try {
        await resend.emails.send({
          from: 'Escape Hatch Transcription <onboarding@resend.dev>',
          to: FEEDBACK_EMAIL,
          subject: `📝 Transcription Error: ${report.episodeTitle}`,
          html: emailHtml,
        });
        console.log('Transcription error email sent successfully');
      } catch (emailError) {
        console.error('Failed to send transcription error email:', emailError);
      }
    } else {
      console.warn('RESEND_API_KEY not configured - email not sent');
    }

    return NextResponse.json({ success: true, id: report.id });
  } catch (error) {
    console.error('Transcription error submission failed:', error);
    return NextResponse.json(
      { error: 'Failed to submit transcription error report' },
      { status: 500 }
    );
  }
}
