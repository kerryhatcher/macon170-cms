export interface Env {
  MEDIA_BUCKET: R2Bucket;
}

/**
 * This Worker is deployed only by the close workflow, immediately invoked,
 * then deleted. R2 has no Wrangler command to list all object keys, so empty
 * the preview-only bucket through its binding before deleting the bucket.
 */
export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    let cursor: string | undefined;
    let deleted = 0;

    do {
      const page = await env.MEDIA_BUCKET.list({ cursor });
      if (page.objects.length > 0) {
        await env.MEDIA_BUCKET.delete(page.objects.map(({ key }) => key));
        deleted += page.objects.length;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    return Response.json({ deleted });
  },
};
