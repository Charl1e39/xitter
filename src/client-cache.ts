// Local archive of the pinned web client. Files are stored exactly as the CDN
// served them; patching happens at serve time so the archive stays pristine.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

export const CLIENT_DIR = process.env.CLIENT_DIR ?? "client";
export const CDN_ORIGIN = "https://abs.twimg.com";
const downloads = new Map<string, Promise<Buffer | undefined>>();
// /abs/ answers before sign-in, so what it will fetch and keep is the
// client's own: its bundle, its stock images and the chat app, each a bounded size
const FETCHED = /^\/(responsive-web\/|sticky\/|x-web\/xchat\/)/;
const MAX_FILE = 32 * 1024 * 1024;

// (federation.ts has one too, but importing it would bring the database into
// the client fetcher script)
async function readLimited(r: Response, max: number): Promise<Uint8Array> {
	if (Number(r.headers.get("content-length") ?? 0) > max) throw new Error("too large");
	const reader = r.body?.getReader();
	if (!reader) return new Uint8Array();
	const parts: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > max) {
			await reader.cancel();
			throw new Error("too large");
		}
		parts.push(value);
	}
	return Buffer.concat(parts);
}

function localPath(cdnPath: string): string | undefined {
	const clean = normalize(cdnPath).replace(/^([/\\])+/, "");
	if (clean.startsWith("..")) return undefined;
	return join(CLIENT_DIR, "abs", clean);
}

export function readCached(cdnPath: string): Buffer | undefined {
	const p = localPath(cdnPath);
	// a directory (someone asked for /abs/.../) is not a file to serve
	return p && existsSync(p) && statSync(p).isFile() ? readFileSync(p) : undefined;
}

// Returns the file from the archive, downloading it from the CDN on first use.
export async function getClientFile(cdnPath: string, allowFetch = true): Promise<Buffer | undefined> {
	const cached = readCached(cdnPath);
	if (cached || !allowFetch) return cached;
	const p = localPath(cdnPath);
	if (!p || (existsSync(p) && !statSync(p).isFile()) || !FETCHED.test(cdnPath)) return undefined;
	let pending = downloads.get(p);
	if (!pending) {
		pending = (async () => {
			const res = await fetch(CDN_ORIGIN + cdnPath);
			if (!res.ok) return undefined;
			const buf = Buffer.from(await readLimited(res, MAX_FILE).catch(() => new Uint8Array()));
			if (!buf.length) return undefined;
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(p, buf);
			return buf;
		})();
		downloads.set(p, pending);
		void pending.then(() => downloads.delete(p), () => downloads.delete(p));
	}
	return pending;
}

export async function getClientFilePath(cdnPath: string): Promise<string | undefined> {
	const p = localPath(cdnPath);
	if (!p) return undefined;
	if (existsSync(p)) return statSync(p).isFile() ? p : undefined;
	return (await getClientFile(cdnPath)) ? p : undefined;
}
