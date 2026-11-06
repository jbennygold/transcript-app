// Opens the missing thread on the currently open episode's #engineers
// announcement and records it on the open-episode pointer. For when the
// notes-open step fell back to the webhook (e.g. a revoked bot token) and
// posted a threadless announcement. Invoked from the "Repair notes thread"
// workflow. Exits non-zero on failure so the run goes red — it's run by hand.

import { getOpenEpisode, setOpenEpisode } from '../src/lib/episode-notes';
import { openThreadOnAnnouncement, threadNameFor } from '../src/lib/discord-thread';

async function main(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_ENGINEERS_CHANNEL_ID;
  if (!token || !channelId) throw new Error('DISCORD_BOT_TOKEN and DISCORD_ENGINEERS_CHANNEL_ID are required.');

  const open = await getOpenEpisode();
  if (!open) throw new Error('No episode is open for notes.');
  if (open.threadId) {
    console.log(`Episode ${open.episode} already has thread ${open.threadId} — nothing to do.`);
    return;
  }

  // Same string the announcement embed uses (see buildNotesOpenMessage).
  const embedTitle = open.film.trim() === '' ? `Episode ${open.episode}` : `Ep ${open.episode} · ${open.film}`;
  const threadId = await openThreadOnAnnouncement({
    token,
    channelId,
    embedTitle,
    threadName: threadNameFor(open.episode, open.film),
  });
  if (!threadId) throw new Error(`Could not open a thread for episode ${open.episode} (see warning above).`);

  await setOpenEpisode({ ...open, threadId });
  console.log(`Opened thread ${threadId} for episode ${open.episode} and recorded it on the pointer.`);
}

main().catch((err) => {
  console.error(`[repair-notes-thread] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
