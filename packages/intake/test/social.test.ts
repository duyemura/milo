import { describe, it, expect } from "vitest";
import { extractInstagramPosts } from "../src/social.ts";

describe("extractInstagramPosts", () => {
  it("pulls captions from window._sharedData when present", () => {
    const html = `
      <script type="text/javascript">window._sharedData = ${JSON.stringify({
        entry_data: {
          ProfilePage: [{
            graphql: {
              user: {
                edge_owner_to_timeline_media: {
                  edges: [
                    { node: { edge_media_to_caption: { edges: [{ node: { text: "First post caption" } }] } } },
                    { node: { edge_media_to_caption: { edges: [{ node: { text: "Second post caption that is quite long and should be truncated by the scraper later" } }] } } },
                    { node: { edge_media_to_caption: { edges: [] } } },
                  ],
                },
              },
            },
          }],
        },
      })};</script>
    `;
    const posts = extractInstagramPosts(html);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toBe("First post caption");
    expect(posts[1].length).toBeLessThanOrEqual(280);
  });

  it("returns empty array when _sharedData is missing or malformed", () => {
    expect(extractInstagramPosts("<html></html>")).toEqual([]);
    expect(extractInstagramPosts(`<script>window._sharedData = { notProfile: true };</script>`)).toEqual([]);
    expect(extractInstagramPosts(`<script>window._sharedData = not valid json;</script>`)).toEqual([]);
  });
});
