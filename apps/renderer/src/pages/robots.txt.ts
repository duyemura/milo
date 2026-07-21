export function GET() {
  const site = (process.env.SITE_URL ?? "https://example.com").replace(/\/$/, "");
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "",
    `Sitemap: ${site}/sitemap-index.xml`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain" } });
}
