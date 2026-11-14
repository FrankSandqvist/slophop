import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { del, get, list, put } from "@vercel/blob";

/**
 * Tiny storage layer: Vercel Blob when BLOB_READ_WRITE_TOKEN is set,
 * otherwise a local `.data/` folder so the app works in dev with zero setup.
 * All reads go through our own routes, so blob access can be public or private.
 */

export type StoredItem = { pathname: string; uploadedAt: Date };

const useBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
const access = (process.env.BLOB_ACCESS === "public" ? "public" : "private") as "public" | "private";
const localRoot = path.join(process.cwd(), ".data");

function safeLocalPath(pathname: string) {
  const resolved = path.resolve(localRoot, pathname);
  if (!resolved.startsWith(localRoot + path.sep)) throw new Error("Invalid path");
  return resolved;
}

export async function saveFile(pathname: string, body: string | Buffer, contentType: string) {
  if (useBlob) {
    await put(pathname, body, { access, contentType, addRandomSuffix: false, allowOverwrite: true });
    return;
  }
  if (process.env.VERCEL) {
    throw new Error("No blob store is connected. Add a Vercel Blob store to this project (BLOB_READ_WRITE_TOKEN).");
  }
  const target = safeLocalPath(pathname);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body);
}

export async function readFile(pathname: string): Promise<{ body: Buffer; contentType: string } | null> {
  if (useBlob) {
    const result = await get(pathname, { access, useCache: false }).catch(() => null);
    if (!result || result.statusCode !== 200) return null;
    const body = Buffer.from(await new Response(result.stream).arrayBuffer());
    return { body, contentType: result.blob.contentType };
  }
  try {
    const body = await fs.readFile(safeLocalPath(pathname));
    return { body, contentType: contentTypeFor(pathname) };
  } catch {
    return null;
  }
}

/** Deletes files (Blob pathnames, or local paths under .data). Missing files are ignored. */
export async function deleteFiles(pathnames: string[]) {
  if (!pathnames.length) return;
  if (useBlob) {
    for (let start = 0; start < pathnames.length; start += 100) await del(pathnames.slice(start, start + 100));
    return;
  }
  await Promise.all(pathnames.map((pathname) => fs.rm(safeLocalPath(pathname), { force: true })));
}

export async function readText(pathname: string) {
  const file = await readFile(pathname);
  return file ? file.body.toString("utf8") : null;
}

export async function listFiles(prefix: string): Promise<StoredItem[]> {
  if (useBlob) {
    const items: StoredItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      items.push(...page.blobs.map((blob) => ({ pathname: blob.pathname, uploadedAt: new Date(blob.uploadedAt) })));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor && items.length < 5000);
    return items;
  }
  const base = safeLocalPath(prefix.replace(/\/$/, "") || ".");
  const items: StoredItem[] = [];
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const stat = await fs.stat(full);
        items.push({ pathname: path.relative(localRoot, full).split(path.sep).join("/"), uploadedAt: stat.mtime });
      }
    }
  }
  await walk(base);
  return items;
}

function contentTypeFor(pathname: string) {
  if (pathname.endsWith(".json")) return "application/json";
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (pathname.endsWith(".mp3")) return "audio/mpeg";
  if (pathname.endsWith(".wav")) return "audio/wav";
  return "application/octet-stream";
}
