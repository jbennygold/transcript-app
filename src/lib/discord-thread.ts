/**
 * Posting an episode announcement as a bot, with a thread on it.
 *
 * A channel webhook can post a message but cannot create a thread on it; that
 * requires a bot token. This module is the only place in the app repo that
 * talks to Discord as a bot.
 *
 * It lives under src/lib/ rather than scripts/ on purpose: scripts/ is
 * excluded from tsconfig.json, so nothing there is typechecked.
 */

const DISCORD_API = 'https://discord.com/api/v10';

/** Discord rejects thread names longer than this outright. */
const MAX_THREAD_NAME = 100;

/** 7 days, the longest auto-archive Discord offers. */
const AUTO_ARCHIVE_MINUTES = 10080;

export interface AnnounceOptions {
  token: string;
  channelId: string;
  /** The same shape the webhook path posts: { content?, embeds? }. */
  payload: unknown;
  threadName: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/** Matches the announcement embed title, so the thread reads the same way. */
export function threadNameFor(episode: string, film: string): string {
  const name = film ? `Ep ${episode} · ${film}` : `Episode ${episode}`;
  return name.length > MAX_THREAD_NAME ? name.slice(0, MAX_THREAD_NAME) : name;
}

/**
 * Post the announcement and open a thread on it.
 *
 * Returns null when the announcement itself failed. Returns a null `threadId`
 * when the message posted but the thread did not — a degraded success: the
 * announcement is visible and the open-episode pointer is still written, so
 * /pdc-note keeps working and only /pdc-sync-notes has nothing to read.
 * Never throws; every Discord step in this project is non-fatal.
 */
export async function announceWithThread(
  opts: AnnounceOptions
): Promise<{ messageId: string; threadId: string | null } | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bot ${opts.token}`,
    'Content-Type': 'application/json',
  };

  let messageId: string;
  try {
    const res = await doFetch(`${DISCORD_API}/channels/${opts.channelId}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(opts.payload),
    });
    if (!res.ok) {
      console.warn(
        `[discord-thread] posting the announcement returned ${res.status}: ${await res.text()}`
      );
      return null;
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) {
      console.warn('[discord-thread] Discord returned no message id — cannot create a thread.');
      return null;
    }
    messageId = data.id;
  } catch (err) {
    console.warn(
      `[discord-thread] posting the announcement failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  try {
    const res = await doFetch(
      `${DISCORD_API}/channels/${opts.channelId}/messages/${messageId}/threads`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: opts.threadName,
          auto_archive_duration: AUTO_ARCHIVE_MINUTES,
        }),
      }
    );
    if (!res.ok) {
      console.warn(
        `[discord-thread] creating the thread returned ${res.status}: ${await res.text()}`
      );
      return { messageId, threadId: null };
    }
    const data = (await res.json()) as { id?: string };
    return { messageId, threadId: data.id ?? null };
  } catch (err) {
    console.warn(
      `[discord-thread] creating the thread failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return { messageId, threadId: null };
  }
}
