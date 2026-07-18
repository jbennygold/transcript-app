import type { TranscriptionReport } from './transcription-report';

const AMBER = 0xf59e0b;

export interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: { name: string; value: string; inline?: boolean }[];
}

export interface WebhookPayload {
  content?: string;
  embeds: DiscordEmbed[];
}

export function buildReportMessage(report: TranscriptionReport): WebhookPayload {
  const oldValue =
    report.correction.field === 'name' ? report.anchor.speaker : report.anchor.originalText;
  const fields = [
    { name: 'Type', value: report.correction.type, inline: true },
    { name: 'Source', value: report.source, inline: true },
    { name: 'Timestamp', value: report.anchor.startTs, inline: true },
    { name: 'Change', value: `\`${oldValue}\` → \`${report.correction.newValue}\`` },
  ];
  if (report.note) fields.push({ name: 'Note', value: report.note });
  return {
    content: '📝 New transcription error report to review',
    embeds: [
      {
        title: `Ep ${report.episodeNumber} · transcription report`,
        color: AMBER,
        fields,
      },
    ],
  };
}

async function postToDiscord(webhookUrl: string, payload: WebhookPayload): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook returned ${res.status}: ${await res.text()}`);
  }
}

export async function notifyNewReport(report: TranscriptionReport): Promise<void> {
  const webhookUrl = process.env.DISCORD_PDC_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[discord-notify] DISCORD_PDC_WEBHOOK_URL not set — skipping.');
    return;
  }
  try {
    await postToDiscord(webhookUrl, buildReportMessage(report));
  } catch (err) {
    console.error('[discord-notify] failed to post report notification:', err);
  }
}
