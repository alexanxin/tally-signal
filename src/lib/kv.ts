import { Redis } from "@upstash/redis";

/**
 * Lazy Upstash Redis client.
 *
 * Returns null when no KV is provisioned so callers can degrade gracefully
 * (e.g. a download counter that no-ops without breaking the download).
 *
 * Vercel's KV integration ships env vars under the legacy KV_REST_API_*
 * prefix as well as the newer UPSTASH_REDIS_REST_* names depending on
 * provisioning vintage. We accept either.
 */
const url =
  process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token =
  process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

export const kv: Redis | null =
  url && token ? new Redis({ url, token }) : null;

export const kvConfigured = kv !== null;
