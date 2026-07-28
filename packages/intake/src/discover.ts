export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Follow redirects and return the canonical origin (`https://host/`). */
export async function normalizeBaseUrl(input: string, fetchLike: FetchLike): Promise<string> {
  try {
    const res = await fetchLike(input, { redirect: "follow" });
    const finalUrl = new URL(res.url || input);
    return `${finalUrl.origin}/`;
  } catch {
    return `${new URL(input).origin}/`;
  }
}
