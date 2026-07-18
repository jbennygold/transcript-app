const GITHUB_REPO = 'jbennygold/transcript-app';
const WORKFLOW_FILE = 'ingest-episode.yml';

/**
 * Dispatch the ingest-episode GitHub Actions workflow for one episode.
 * Returns { ok: false } (never throws) when the token is missing or GitHub rejects.
 */
export async function triggerRebuild(
  episode: number | string,
): Promise<{ ok: boolean; error?: string; status?: number }> {
  const githubToken = process.env.GITHUB_PAT;
  if (!githubToken) return { ok: false, error: 'GITHUB_PAT not configured' };

  const ep = String(episode);
  if (!ep || ep === 'undefined') return { ok: false, error: 'Missing episode number' };

  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ ref: 'master', inputs: { episode: ep } }),
      },
    );
    if (!response.ok) {
      return { ok: false, error: await response.text(), status: response.status };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}
