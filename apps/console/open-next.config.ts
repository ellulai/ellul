import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// For simple deployments without KV/D1 bindings, use dummy caches
// Upgrade to KV/D1 caches when you need ISR or tag-based revalidation
export default defineCloudflareConfig({
  // Use dummy caches for initial deployment (no bindings required)
  // To enable proper caching, set up KV namespace and D1 database:
  // incrementalCache: KVIncrementalCache,
  // tagCache: D1NextTagCache,
  // queue: doQueue,
});
