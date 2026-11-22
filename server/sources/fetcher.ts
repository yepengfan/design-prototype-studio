import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, paths } from "../config.js";
import { StudioError } from "../errors.js";

/**
 * Reads a registry document over HTTP(S) or `file:`, caching the body on disk.
 *
 * Registry payloads are immutable for a published version, so a disk cache keeps
 * repeated catalog reads and preview builds off the network without hiding the
 * real source: every cached entry records the URL it came from.
 */
export async function fetchDocument(url: string): Promise<string> {
  if (url.startsWith("file:")) return fs.readFile(fileURLToPath(url), "utf8");
  if (!/^https?:\/\//.test(url))
    throw new StudioError(`A design system source must be an http(s) or file URL, not "${url}".`);

  const cacheFile = path.join(paths.registryCache(), `${createHash("sha256").update(url).digest("hex")}.json`);
  const cached = await readCache(cacheFile);
  if (cached) return cached;

  const response = await fetchWithTimeout(url);
  if (!response.ok)
    throw new StudioError(
      `The registry answered ${response.status} for ${url}. Check the source URL and the item name.`,
      response.status === 404 ? 404 : 502,
    );
  const body = await response.text();
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify({ url, fetchedAt: Date.now(), body }));
  return body;
}

/** Reports whether a registry document exists, without throwing on a 404. */
export async function documentExists(url: string): Promise<boolean> {
  try {
    await fetchDocument(url);
    return true;
  } catch (error) {
    if (error instanceof StudioError && error.status === 404) return false;
    throw error;
  }
}

export async function fetchJson<T>(url: string): Promise<T> {
  const body = await fetchDocument(url);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new StudioError(`${url} did not return JSON. A registry must publish JSON registry items.`);
  }
}

async function readCache(file: string): Promise<string | undefined> {
  try {
    const entry = JSON.parse(await fs.readFile(file, "utf8")) as { fetchedAt: number; body: string };
    if (Date.now() - entry.fetchedAt > config.registryCacheSeconds * 1000) return undefined;
    return entry.body;
  } catch {
    return undefined;
  }
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.networkTimeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
  } catch (error) {
    throw new StudioError(
      `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}
