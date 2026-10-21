/**
 * winfs-bridge - make Windows drives fast for pi running inside WSL2.
 *
 * The problem
 * -----------
 * WSL2 mounts Windows drives through drvfs/9p. Every stat/open/readdir crosses
 * the 9p boundary, so anything that walks a tree (grep, find, git status, ls)
 * is ~50x slower than native NTFS. Measured on this machine: walking 4927
 * files took 6.385 s through 9p and 0.116 s on Windows.
 *
 * The fix
 * -------
 * A small helper process runs on the Windows side and performs the file
 * operations directly against NTFS. This extension routes every file operation
 * that targets a Windows drive through that helper over TCP, so pi sees native
 * Windows speed for /mnt/c, /mnt/d, ... while the tools, the schema and the
 * workflow all stay exactly the same.
 *
 * How it works
 * ------------
 * - /proc/mounts is parsed to discover drvfs mounts and their Windows roots
 *   (the kernel exposes them as `aname=drvfs;path=C:\`).
 * - read/write/edit/ls/find are re-registered with pi's own definitions, only
 *   their low level file operations are redirected to the bridge. All of pi's
 *   semantics (fuzzy edit matching, diff output, truncation, rendering) stay
 *   untouched.
 * - grep is re-implemented on top of the bridge (ripgrep runs on Windows).
 * - If the bridge cannot start, everything transparently falls back to the
 *   normal (slow but correct) path.
 *
 * The helper is bridge.py, a dependency-free Python script that is copied to
 * the Windows temp directory and started through WSL interop.
 */

import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	detectSupportedImageMimeTypeFromFile,
	formatSize,
	getAgentDir,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BRIDGE_VERSION = "1.0.0";
const GREP_MAX_LINE_LENGTH = 500;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 1000;
const MAX_TEXT_BYTES = 51200;

// ---------------------------------------------------------------------------
// Windows mount discovery
// ---------------------------------------------------------------------------

type WinMount = { mountPoint: string; winRoot: string };

let MOUNTS: WinMount[] = [];

function detectWinMounts(): WinMount[] {
	const mounts: WinMount[] = [];
	let text = "";
	try {
		text = readFileSync("/proc/mounts", "utf8");
	} catch {
		return mounts;
	}
	for (const line of text.split("\n")) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 4) continue;
		const fsType = parts[2];
		const mountPoint = decodeURIComponent(parts[1]);
		const options = parts[3];
		if (fsType !== "9p" && fsType !== "drvfs") continue;
		const match = /aname=drvfs;path=([^;]*)/.exec(options);
		if (!match) continue;
		let winRoot = match[1];
		if (!winRoot.endsWith("\\")) winRoot += "\\";
		mounts.push({ mountPoint, winRoot });
	}
	return mounts;
}

/** Linux path -> Windows path, or null when the path is not on a Windows drive. */
function toWinPath(target: string): string | null {
	const abs = path.resolve(target);
	for (const mount of MOUNTS) {
		if (abs === mount.mountPoint) return mount.winRoot;
		if (abs.startsWith(mount.mountPoint + "/")) {
			const rest = abs.slice(mount.mountPoint.length + 1).split("/").join("\\");
			return mount.winRoot + rest;
		}
	}
	return null;
}

/** Windows path -> Linux path (best effort, used for display). */
function toWslPath(target: string): string {
	const normalized = target.replace(/\//g, "\\");
	for (const mount of MOUNTS) {
		if (normalized.toLowerCase().startsWith(mount.winRoot.toLowerCase())) {
			const rest = normalized.slice(mount.winRoot.length).split("\\").join("/");
			return rest ? mount.mountPoint + "/" + rest : mount.mountPoint;
		}
	}
	return target;
}

/**
 * Normalize a path reported by the Windows helper. The helper runs with its
 * working directory set to the search root, so the paths it prints are
 * relative to that root and use Windows separators.
 */
/** True for file types the built-in read tool sends as inline images. */
function isImagePath(target: string): boolean {
	return /\.(jpe?g|png|gif|webp|bmp)$/i.test(target);
}

function normalizeBridgePath(raw: string): string {
	let text = raw.replace(/\\/g, "/");
	while (text.startsWith("./")) text = text.slice(2);
	return text;
}

// ---------------------------------------------------------------------------
// bridge client
// ---------------------------------------------------------------------------

type BridgeResult = any;

class BridgeConnection {
	private socket!: net.Socket;
	private buffers: Buffer[] = [];
	private scanPos = 0;
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private nextId = 1;
	private closed = false;

	constructor(
		private readonly host: string,
		private readonly port: number,
		private readonly token: string,
	) {}

	connect(timeoutMs = 1500): Promise<void> {
		return new Promise((resolve, reject) => {
			const socket = net.createConnection({ host: this.host, port: this.port });
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error("bridge connect timeout"));
			}, timeoutMs);
			socket.once("connect", () => {
				clearTimeout(timer);
				this.socket = socket;
				socket.setNoDelay(true);
				socket.on("data", (chunk) => this.onData(chunk));
				socket.on("close", () => this.onClose());
				socket.on("error", () => this.onClose());
				resolve();
			});
			socket.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
	}

	private onData(chunk: Buffer) {
		// Keep the incoming bytes in a queue instead of concatenating strings:
		// string concatenation would re-copy the whole response for every
		// chunk, which turns large reads into quadratic work.
		this.buffers.push(chunk);
		for (;;) {
			const newline = this.findNewline();
			if (newline < 0) break;
			const line = this.take(newline + 1).trim();
			if (!line) continue;
			let message: any;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			const entry = this.pending.get(message.id);
			if (!entry) continue;
			this.pending.delete(message.id);
			if (message.ok) entry.resolve(message.result);
			else entry.reject(new Error(message.error || "bridge error"));
		}
	}

	/**
	 * Absolute offset of the next newline in the queued bytes, or -1.
	 * `scanPos` remembers how much has already been searched so that large
	 * responses are not rescanned for every incoming chunk.
	 */
	private findNewline(): number {
		let offset = 0;
		for (const buffer of this.buffers) {
			if (offset + buffer.length > this.scanPos) {
				const from = Math.max(0, this.scanPos - offset);
				const found = buffer.indexOf(10, from);
				if (found >= 0) return offset + found;
			}
			offset += buffer.length;
		}
		this.scanPos = offset;
		return -1;
	}

	/** Consume the first `count` queued bytes and return them as a string. */
	private take(count: number): string {
		let remaining = count;
		const parts: Buffer[] = [];
		while (remaining > 0 && this.buffers.length > 0) {
			const buffer = this.buffers[0];
			if (buffer.length <= remaining) {
				parts.push(buffer);
				remaining -= buffer.length;
				this.buffers.shift();
			} else {
				parts.push(buffer.subarray(0, remaining));
				this.buffers[0] = buffer.subarray(remaining);
				remaining = 0;
			}
		}
		this.scanPos = Math.max(0, this.scanPos - count);
		return Buffer.concat(parts).toString("utf8");
	}

	private onClose() {
		if (this.closed) return;
		this.closed = true;
		for (const [, entry] of this.pending) entry.reject(new Error("bridge connection closed"));
		this.pending.clear();
		try {
			this.socket?.destroy();
		} catch {
			/* ignore */
		}
	}

	call(op: string, args: Record<string, unknown>, timeoutMs = 120000): Promise<BridgeResult> {
		if (this.closed) return Promise.reject(new Error("bridge connection closed"));
		const id = this.nextId++;
		return new Promise<BridgeResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`bridge op ${op} timed out`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.socket.write(JSON.stringify({ id, token: this.token, op, args }) + "\n");
		});
	}

	close() {
		this.closed = true;
		try {
			this.socket?.destroy();
		} catch {
			/* ignore */
		}
	}
}

/** Pool of connections so parallel tool calls do not queue up behind each other. */
class Bridge {
	private idle: BridgeConnection[] = [];

	constructor(
		readonly host: string,
		readonly port: number,
		private readonly token: string,
	) {}

	private async acquire(): Promise<BridgeConnection> {
		while (this.idle.length > 0) {
			const connection = this.idle.pop()!;
			try {
				await connection.call("ping", {}, 5000);
				return connection;
			} catch {
				connection.close();
			}
		}
		const connection = new BridgeConnection(this.host, this.port, this.token);
		await connection.connect();
		return connection;
	}

	private release(connection: BridgeConnection) {
		this.idle.push(connection);
	}

	async call(op: string, args: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResult> {
		const connection = await this.acquire();
		try {
			return await connection.call(op, args, timeoutMs);
		} finally {
			this.release(connection);
		}
	}

	close() {
		for (const connection of this.idle) connection.close();
		this.idle = [];
	}
}

// ---------------------------------------------------------------------------
// bridge lifecycle (start / reuse the Windows side helper)
// ---------------------------------------------------------------------------

type BridgeStatus = {
	state: "idle" | "starting" | "ready" | "unavailable";
	host?: string;
	port?: number;
	version?: string;
	detail?: string;
};

class BridgeManager {
	status: BridgeStatus = { state: "idle" };
	private bridge: Bridge | null = null;
	private startPromise: Promise<Bridge | null> | null = null;
	private retryAfter = 0;

	constructor(private readonly mounts: WinMount[]) {}

	async ensure(): Promise<Bridge | null> {
		if (this.bridge) return this.bridge;
		if (this.status.state === "unavailable" && Date.now() < this.retryAfter) return null;
		if (!this.startPromise) {
			this.startPromise = this.start().finally(() => {
				this.startPromise = null;
			});
		}
		return this.startPromise;
	}

	private async start(): Promise<Bridge | null> {
		this.status = { state: "starting" };
		try {
			const python = await findWindowsPython();
			if (!python) {
				this.fail("no python.exe found on Windows");
				return null;
			}
			const tempDir = await windowsTempDir();
			if (!tempDir) {
				this.fail("cannot resolve the Windows temp directory");
				return null;
			}
			const scriptSource = this.locateBridgeScript();
			if (!scriptSource) {
				this.fail("bridge.py not found next to the extension");
				return null;
			}
			const winDir = path.win32.join(tempDir, "pi-winfs-bridge");
			const wslDir = toWslPath(winDir);
			mkdirSync(wslDir, { recursive: true });
			const scriptTarget = path.join(wslDir, "bridge.py");
			const source = readFileSync(scriptSource);
			if (!existsSync(scriptTarget) || !source.equals(readFileSync(scriptTarget))) {
				writeFileSync(scriptTarget, source);
			}

			// Reuse a helper that is already running the very same script.
			// Starting a fresh helper for every pi session would leave one
			// Windows process behind per session.
			const reused = await this.reuseRunningBridge(wslDir, scriptSource);
			if (reused) return reused;

			const endpointWin = path.win32.join(winDir, "endpoint.json");
			const endpointWsl = toWslPath(endpointWin);
			try {
				// Clear a stale endpoint file so we know the new helper is the one answering.
				writeFileSync(endpointWsl, "");
			} catch {
				/* ignore */
			}

			const token = crypto.randomBytes(24).toString("hex");
			const port = 7411 + Math.floor(Math.random() * 500);
			const host = wslGatewayIp() ?? "127.0.0.1";

			const args = [
				path.win32.join(winDir, "bridge.py"),
				"--host",
				host,
				"--port",
				String(port),
				"--token",
				token,
				"--endpoint-file",
				endpointWin,
				"--idle-timeout",
				"3600",
			];
			for (const mount of this.mounts) args.push("--allow-root", mount.winRoot);

			// The helper prints its endpoint on stdout. Reading it there avoids
			// depending on the endpoint file, because a file written on Windows
			// can stay invisible in WSL for several seconds (drvfs cache).
			const child = spawn(toWslPath(python), args, {
				detached: true,
				stdio: ["ignore", "pipe", "ignore"],
				cwd: "/",
			});
			child.on("error", () => undefined);
			child.unref();
			const announced = await readAnnouncedPort(child, 10000);
			child.stdout?.destroy();

			let endpointPort = announced ?? port;
			let endpointHost = host;
			if (!announced) {
				// Fall back to the endpoint file (the helper may have shifted ports).
				const endpoint = await waitForEndpoint(endpointWsl, token, 8000);
				if (!endpoint) {
					this.fail("the Windows helper did not start");
					return null;
				}
				endpointPort = endpoint.port;
				endpointHost = endpoint.host ?? host;
			}

			const bridge = new Bridge(endpointHost, endpointPort, token);
			const pong = await bridge.call("ping", {}, 5000);
			this.bridge = bridge;
			this.status = {
				state: "ready",
				host: bridge.host,
				port: bridge.port,
				version: pong?.version,
				detail: `connected to the Windows helper (pid ${pong?.pid})`,
			};
			return bridge;
		} catch (error) {
			this.fail(error instanceof Error ? error.message : String(error));
			return null;
		}
	}

	private fail(detail: string) {
		this.status = { state: "unavailable", detail };
		this.retryAfter = Date.now() + 15000;
	}

	/**
	 * Look for a helper that is already running the same bridge.py and reuse
	 * it. The helper reports the hash of the script it runs, so a helper built
	 * from an older version of bridge.py is never reused.
	 */
	private async reuseRunningBridge(wslDir: string, scriptSource: string): Promise<Bridge | null> {
		let expected: string;
		try {
			expected = crypto.createHash("sha256").update(readFileSync(scriptSource)).digest("hex");
		} catch {
			return null;
		}
		let entries: string[];
		try {
			entries = readdirSync(wslDir);
		} catch {
			return null;
		}
		for (const entry of entries) {
			if (!/^endpoint.*\.json$/i.test(entry)) continue;
			let info: { host?: string; port?: number; token?: string };
			try {
				info = JSON.parse(readFileSync(path.join(wslDir, entry), "utf8"));
			} catch {
				continue;
			}
			if (!info?.port || !info?.token || !info?.host) continue;
			try {
				const bridge = new Bridge(info.host, info.port, info.token);
				// Probe quickly: a stale endpoint file must not delay the start.
				const pong = await bridge.call("ping", {}, 800);
				if (pong?.script && pong.script !== expected) {
					bridge.close();
					continue;
				}
				this.bridge = bridge;
				this.status = {
					state: "ready",
					host: bridge.host,
					port: bridge.port,
					version: pong?.version,
					detail: `reused the running Windows helper (pid ${pong?.pid})`,
				};
				return bridge;
			} catch {
				/* this helper is gone or unreachable */
			}
		}
		return null;
	}

	private locateBridgeScript(): string | null {
		const candidates: string[] = [];
		try {
			candidates.push(path.join(path.dirname(fileURLToPath(import.meta.url)), "bridge.py"));
		} catch {
			/* import.meta.url unavailable */
		}
		candidates.push(path.join(getAgentDir(), "extensions", "winfs-bridge", "bridge.py"));
		for (const candidate of candidates) {
			if (candidate && existsSync(candidate)) return candidate;
		}
		return null;
	}

	async shutdown() {
		this.bridge?.close();
		this.bridge = null;
	}

	/** Drop the current helper connection so the next call starts a fresh one. */
	invalidate(reason: string) {
		this.bridge?.close();
		this.bridge = null;
		this.status = { ...this.status, state: "unavailable", detail: reason };
	}

	/**
	 * Call the Windows helper. A lost connection invalidates the helper and
	 * the call is retried once against a freshly started helper.
	 */
	async call<T>(op: string, args: Record<string, unknown>, timeoutMs?: number): Promise<T> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			const bridge = await this.ensure();
			if (!bridge) throw new Error("the native Windows helper is not available");
			try {
				return (await bridge.call(op, args, timeoutMs)) as T;
			} catch (error) {
				lastError = error;
				this.invalidate(`bridge error: ${(error as Error).message}`);
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}
}

// ---------------------------------------------------------------------------
// Windows interop helpers
// ---------------------------------------------------------------------------

const CMD = "/mnt/c/Windows/System32/cmd.exe";

function runWindows(command: string, timeoutMs = 8000): Promise<string> {
	return new Promise((resolve, reject) => {
		if (!existsSync(CMD)) {
			reject(new Error("cmd.exe is not available"));
			return;
		}
		execFile(
			CMD,
			["/c", command],
			{ cwd: "/mnt/c/Windows", timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout) => {
				if (error) reject(error);
				else resolve(String(stdout));
			},
		);
	});
}

let pythonCache: string | null | undefined;
async function findWindowsPython(): Promise<string | null> {
	if (pythonCache !== undefined) return pythonCache;
	try {
		const output = await runWindows("where python.exe");
		const lines = output
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line && !line.toLowerCase().startsWith("info:"));
		const candidate = lines.find((line) => /\.exe$/i.test(line) && !/WindowsApps/i.test(line));
		pythonCache = candidate ?? null;
	} catch {
		pythonCache = null;
	}
	return pythonCache;
}

let tempCache: string | null | undefined;
async function windowsTempDir(): Promise<string | null> {
	if (tempCache !== undefined) return tempCache;
	try {
		const output = await runWindows("echo %TEMP%");
		const value = output
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)[0];
		tempCache = value && /^[A-Za-z]:/.test(value) ? value : null;
	} catch {
		tempCache = null;
	}
	return tempCache;
}

/** The Windows host address as seen from WSL (NAT mode gateway). */
function wslGatewayIp(): string | null {
	try {
		const text = readFileSync("/proc/net/route", "utf8");
		for (const line of text.split("\n").slice(1)) {
			const parts = line.trim().split(/\s+/);
			if (parts.length < 3) continue;
			const [, destination, gateway] = parts;
			if (destination !== "00000000") continue;
			const hex = gateway.trim();
			if (!/^[0-9a-fA-F]{8}$/.test(hex)) continue;
			// /proc/net/route stores the address in little endian byte order.
			const octets = [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16));
			const ip = octets.join(".");
			if (ip.startsWith("0.") || ip === "0.0.0.0") continue;
			return ip;
		}
	} catch {
		/* ignore */
	}
	return null;
}

/**
 * Read the port the Windows helper announced on stdout.
 * The helper prints `listening on <host>:<port>` once it is bound.
 */
function readAnnouncedPort(child: { stdout: NodeJS.ReadableStream | null }, timeoutMs: number): Promise<number | null> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => done(null), timeoutMs);
		let buffer = "";
		child.stdout?.on("data", (chunk: Buffer | string) => {
			buffer += chunk.toString();
			const match = /listening on [^\s:]+:(\d+)/.exec(buffer);
			if (match) done(Number(match[1]));
		});
		child.stdout?.on("error", () => done(null));
		child.stdout?.on("end", () => done(null));
	});
}

async function waitForEndpoint(
	endpointPath: string,
	token: string,
	timeoutMs: number,
): Promise<{ host: string; port: number; token: string } | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if (existsSync(endpointPath)) {
				const raw = readFileSync(endpointPath, "utf8");
				if (raw.trim()) {
					const parsed = JSON.parse(raw);
					if (parsed.token === token && parsed.port) {
						return { host: parsed.host, port: parsed.port, token: parsed.token };
					}
				}
			}
		} catch {
			/* retry */
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return null;
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Only meaningful inside WSL with Windows drives mounted.
	if (process.platform === "win32") return;

	// Escape hatch: WINFS_BRIDGE=0 in the environment, or an empty
	// ~/.pi/agent/winfs-bridge.disabled file, turns the whole thing off.
	if (process.env.WINFS_BRIDGE === "0") return;
	if (existsSync(path.join(getAgentDir(), "winfs-bridge.disabled"))) return;

	MOUNTS = detectWinMounts();
	if (MOUNTS.length === 0) return;

	const manager = new BridgeManager(MOUNTS);
	const baseCwd = process.cwd();

	const winOf = (target: string) => toWinPath(target);

	// -- shared bridge operations -------------------------------------------

	const bridgeRead = async (filePath: string): Promise<Buffer> => {
		const win = winOf(filePath);
		// Paths that are not on a Windows drive stay on the plain WSL path.
		if (!win) return readFile(filePath);
		try {
			const result = await manager.call<any>("read", { path: win });
			if (result?.encoding === "base64") return Buffer.from(result.data, "base64");
			return Buffer.from(result?.data ?? "", "utf8");
		} catch {
			return readFile(filePath);
		}
	};

	const bridgeAccess = async (filePath: string) => {
		const win = winOf(filePath);
		if (!win) return access(filePath, constants.R_OK);
		let result: any;
		try {
			result = await manager.call<any>("stat", { path: win });
		} catch {
			return access(filePath, constants.R_OK);
		}
		if (!result?.exists) {
			const error: NodeJS.ErrnoException = new Error(
				`ENOENT: no such file or directory, open '${filePath}'`,
			);
			error.code = "ENOENT";
			throw error;
		}
	};

	const bridgeWrite = async (filePath: string, content: string) => {
		const win = winOf(filePath);
		if (!win) return writeFile(filePath, content, "utf-8");
		try {
			await manager.call("write", { path: win, data: content, encoding: "utf8" });
		} catch {
			await writeFile(filePath, content, "utf-8");
		}
	};

	const bridgeMkdir = async (dir: string) => {
		const win = winOf(dir);
		if (!win) return mkdir(dir, { recursive: true });
		try {
			await manager.call("mkdir", { path: win });
		} catch {
			await mkdir(dir, { recursive: true });
		}
	};

	// Directory listing cache: the built-in ls stats every entry separately.
	// The bridge returns the directory flags with the listing, so one round
	// trip is enough.
	let listCache: { dir: string; entries: Map<string, boolean> } | null = null;

	// -- read ---------------------------------------------------------------

	const baseRead = createReadToolDefinition(baseCwd);
	pi.registerTool({
		...createReadToolDefinition(baseCwd, {
			operations: {
				readFile: bridgeRead,
				access: bridgeAccess,
				detectImageMimeType: async (filePath: string) => {
					const win = winOf(filePath);
					if (!win) return detectSupportedImageMimeTypeFromFile(filePath);
					const bridge = await manager.ensure();
					if (!bridge) return detectSupportedImageMimeTypeFromFile(filePath);
					try {
						const result = await manager.call<any>("sniff", { path: win });
						return result?.mimeType ?? undefined;
					} catch {
						return detectSupportedImageMimeTypeFromFile(filePath);
					}
				},
			},
		}),
		description: `${baseRead.description}\n\nFiles under /mnt/<drive> are read by a native Windows helper, so they load at Windows speed.`,
		promptGuidelines: [
			...(baseRead.promptGuidelines ?? []),
			"Windows drive paths (/mnt/c/...) are served natively on Windows and are fast: use read/edit/write/grep/find on them instead of bash.",
		],
		execute: async (toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) => {
			const absolute = path.resolve(ctx?.cwd || baseCwd, params.path || ".");
			if (!winOf(absolute)) return baseRead.execute(toolCallId, params, signal, onUpdate, ctx);
			// Images keep the built-in path (it owns the resize pipeline).
			if (isImagePath(absolute)) return baseRead.execute(toolCallId, params, signal, onUpdate, ctx);
			const bridge = await manager.ensure();
			if (!bridge) return baseRead.execute(toolCallId, params, signal, onUpdate, ctx);
			try {
				const win = winOf(absolute)!;
				const stat = await manager.call<any>("stat", { path: win });
				if (!stat?.exists) {
					const error: NodeJS.ErrnoException = new Error(
						`ENOENT: no such file or directory, open '${absolute}'`,
					);
					error.code = "ENOENT";
					throw error;
				}
				const offset = params.offset as number | undefined;
				const limit = params.limit as number | undefined;
				// Ask the Windows side for just the requested line window so a
				// huge file does not have to travel across the socket in full.
				const result = await manager.call<any>("read", { path: win, offset, limit });
				const textContent = String(result?.data ?? "");
				const allLines = textContent.split("\n");
				const totalFileLines = result?.totalLines ?? allLines.length;
				const startLine = offset ? Math.max(0, offset - 1) : 0;
				const startLineDisplay = startLine + 1;
				let selectedContent: string;
				let userLimitedLines: number | undefined;
				if (limit !== undefined) {
					const endLine = Math.min(startLine + limit, allLines.length);
					selectedContent = allLines.slice(startLine, endLine).join("\n");
					userLimitedLines = endLine - startLine;
				} else {
					selectedContent = allLines.slice(startLine).join("\n");
				}
				const truncation = truncateHead(selectedContent);
				let outputText: string;
				let details: any = undefined;
				if (truncation.firstLineExceedsLimit) {
					const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine] ?? "", "utf-8"));
					outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(MAX_TEXT_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${params.path} | head -c ${MAX_TEXT_BYTES}]`;
					details = { truncation };
				} else if (truncation.truncated) {
					const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
					const nextOffset = endLineDisplay + 1;
					outputText = truncation.content;
					outputText +=
						truncation.truncatedBy === "lines"
							? `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
							: `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(MAX_TEXT_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
					details = { truncation };
				} else if (userLimitedLines !== undefined && startLine + userLimitedLines < totalFileLines) {
					const remaining = totalFileLines - (startLine + userLimitedLines);
					const nextOffset = startLine + userLimitedLines + 1;
					outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
				} else {
					outputText = truncation.content;
				}
				return {
					content: [{ type: "text", text: outputText }],
					details,
					structuredContent: outputText,
				};
			} catch (error) {
				if (error instanceof Error && /bridge/i.test(error.message)) {
					return baseRead.execute(toolCallId, params, signal, onUpdate, ctx);
				}
				throw error;
			}
		},
	} as any);

	// -- write --------------------------------------------------------------

	// `write` is deliberately NOT taken over.
	//
	// It is a contested name: other extensions (ccstyle renders a rich diff
	// for it) register their own version, and whoever registers first owns it.
	// Writing a file through 9p costs about 7 ms, so there is nothing to win
	// here, while clobbering another extension's tool would break a feature
	// the user actually uses. File *edits* go through the `edit` tool below,
	// which does use the Windows helper.

	// -- edit ---------------------------------------------------------------

	const baseEdit = createEditToolDefinition(baseCwd);
	pi.registerTool({
		...createEditToolDefinition(baseCwd, {
			operations: {
				readFile: bridgeRead,
				writeFile: bridgeWrite,
				access: bridgeAccess,
			},
		}),
		description: `${baseEdit.description}\n\nFiles under /mnt/<drive> are edited through a native Windows helper, so they save at Windows speed.`,
	} as any);

	// -- ls -----------------------------------------------------------------

	const baseLs = createLsToolDefinition(baseCwd);
	pi.registerTool({
		...createLsToolDefinition(baseCwd, {
			operations: {
				exists: async (dirPath: string) => {
					const win = winOf(dirPath);
					if (!win) {
						try {
							await access(dirPath, constants.F_OK);
							return true;
						} catch {
							return false;
						}
					}
					const bridge = await manager.ensure();
					if (!bridge) {
						try {
							await access(dirPath, constants.F_OK);
							return true;
						} catch {
							return false;
						}
					}
					try {
						const result = await manager.call<any>("stat", { path: win });
						return !!result?.exists;
					} catch {
						try {
							await access(dirPath, constants.F_OK);
							return true;
						} catch {
							return false;
						}
					}
				},
				stat: async (dirPath: string) => {
					const win = winOf(dirPath);
					if (!win) return stat(dirPath);
					if (listCache && path.dirname(dirPath) === listCache.dir) {
						const isDir = listCache.entries.get(path.basename(dirPath));
						if (isDir !== undefined) {
							return {
								isDirectory: () => isDir,
								isFile: () => !isDir,
							} as any;
						}
					}
					const bridge = await manager.ensure();
					if (!bridge) return stat(dirPath);
					try {
						const result = await manager.call<any>("stat", { path: win });
						return {
							isDirectory: () => !!result?.isDir,
							isFile: () => !!result?.isFile,
						} as any;
					} catch {
						return stat(dirPath);
					}
				},
				readdir: async (dirPath: string) => {
					const win = winOf(dirPath);
					if (!win) return readdir(dirPath);
					const bridge = await manager.ensure();
					if (!bridge) return readdir(dirPath);
					let result: any;
					try {
						result = await manager.call<any>("list", { path: win });
					} catch {
						return readdir(dirPath);
					}
					const entries = (result?.entries ?? []) as { name: string; isDir: boolean }[];
					const map = new Map<string, boolean>();
					for (const entry of entries) map.set(entry.name, entry.isDir);
					listCache = { dir: dirPath, entries: map };
					return entries.map((entry) => entry.name);
				},
			},
		}),
		description: `${baseLs.description}\n\nDirectories under /mnt/<drive> are listed by a native Windows helper, so they appear at Windows speed.`,
	} as any);

	// -- find ---------------------------------------------------------------

	const baseFind = createFindToolDefinition(baseCwd);
	pi.registerTool({
		...createFindToolDefinition(baseCwd, {
			operations: {
				exists: async (target: string) => {
					const win = winOf(target);
					if (!win) {
						try {
							await access(target, constants.F_OK);
							return true;
						} catch {
							return false;
						}
					}
					const bridge = await manager.ensure();
					if (!bridge) {
						try {
							await access(target, constants.F_OK);
							return true;
						} catch {
							return false;
						}
					}
					const result = await manager.call<any>("stat", { path: win });
					return !!result?.exists;
				},
				glob: async (pattern: string, searchPath: string, options?: { limit?: number }) => {
					const win = winOf(searchPath);
					if (!win) {
						const { execFile } = await import("node:child_process");
						return new Promise<string[]>((resolve, reject) => {
							execFile("fd", ["--glob", "--color=never", "--hidden", "--", pattern, searchPath], (error, stdout) => {
								if (error) reject(error);
								else resolve(String(stdout).split("\n").filter(Boolean));
							});
						});
					}
					const bridge = await manager.ensure();
					if (!bridge) return [];
					try {
						const result = await manager.call<any>("find", {
							path: win,
							pattern,
							limit: options?.limit ?? DEFAULT_FIND_LIMIT,
						});
						return String(result?.output ?? "")
							.split("\0")
							.filter((file) => file.length > 0)
							.map((file) => path.join(searchPath, normalizeBridgePath(file)));
					} catch {
						return [];
					}
				},
			},
		}),
		description: `${baseFind.description}\n\nSearches under /mnt/<drive> run on Windows and return at Windows speed.`,
	} as any);

	// -- grep ---------------------------------------------------------------

	const baseGrep = createGrepToolDefinition(baseCwd);
	pi.registerTool({
		...baseGrep,
		description: `${baseGrep.description}\n\nSearches under /mnt/<drive> run with ripgrep on Windows and return at Windows speed.`,
		execute: async (toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) => {
			const absolute = path.resolve(ctx?.cwd || baseCwd, params.path || ".");
			if (!winOf(absolute)) return baseGrep.execute(toolCallId, params, signal, onUpdate, ctx);
			const bridge = await manager.ensure();
			if (!bridge) return baseGrep.execute(toolCallId, params, signal, onUpdate, ctx);
			try {
				const effectiveLimit = Math.max(1, (params.limit as number | undefined) ?? DEFAULT_GREP_LIMIT);
				const contextValue = params.context && params.context > 0 ? params.context : 0;
				const statResult = await manager.call<any>("stat", { path: winOf(absolute) });
				if (!statResult?.exists) throw new Error(`Path not found: ${absolute}`);
				const isDirectory = !!statResult.isDir;
				const result = await manager.call<any>("grep", {
					path: winOf(absolute),
					pattern: params.pattern,
					glob: params.glob,
					ignoreCase: !!params.ignoreCase,
					literal: !!params.literal,
					context: contextValue,
					limit: effectiveLimit,
				});
				// ripgrep output on the Windows side: `path\0:line:text` for a match
				// and `path\0-line-text` for a context line. `--null` keeps the
				// path unambiguous even with drive letters, and forwarding the raw
				// output avoids parsing every line twice.
				const rawLines = String(result?.output ?? "")
					.split("\n")
					.filter((line) => line.length > 0);
				if (rawLines.length === 0) {
					return { content: [{ type: "text", text: "No matches found" }], details: undefined };
				}
				const formatPath = (filePath: string) => {
					if (isDirectory) {
						const relative = normalizeBridgePath(filePath);
						if (relative && !relative.startsWith("..")) return relative;
					}
					return path.basename(filePath);
				};
				const outputLines: string[] = [];
				let linesTruncated = false;
				let matchCount = 0;
				for (const rawLine of rawLines) {
					const separator = rawLine.indexOf("\0");
					if (separator < 0) continue;
					const filePath = rawLine.slice(0, separator);
					const parsed = /^(\d+)([:\-])(.*)$/.exec(rawLine.slice(separator + 1));
					if (!parsed) continue;
					const lineNumber = parsed[1];
					const isMatch = parsed[2] === ":";
					if (isMatch) matchCount++;
					const relativePath = formatPath(filePath);
					const { text: truncatedText, wasTruncated } = truncateLine(
						(parsed[3] ?? "").replace(/\r/g, ""),
					);
					if (wasTruncated) linesTruncated = true;
					outputLines.push(
						isMatch
							? `${relativePath}:${lineNumber}: ${truncatedText}`
							: `${relativePath}-${lineNumber}- ${truncatedText}`,
					);
				}
				const matches = { length: matchCount } as any;
				const rawOutput = outputLines.join("\n");
				const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
				let output = truncation.content;
				const details: any = {};
				const notices: string[] = [];
				if (matches.length >= effectiveLimit) {
					notices.push(
						`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
					);
					details.matchLimitReached = effectiveLimit;
				}
				if (truncation.truncated) {
					notices.push(`${formatSize(MAX_TEXT_BYTES)} limit reached`);
					details.truncation = truncation;
				}
				if (linesTruncated) {
					notices.push(
						`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
					);
					details.linesTruncated = true;
				}
				if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
				return {
					content: [{ type: "text", text: output }],
					details: Object.keys(details).length > 0 ? details : undefined,
				};
			} catch (error) {
				if (error instanceof Error && /bridge|Path not found/i.test(error.message)) {
					return baseGrep.execute(toolCallId, params, signal, onUpdate, ctx);
				}
				throw error;
			}
		},
	} as any);

	// -- winfs helper tool --------------------------------------------------

	pi.registerTool({
		name: "winfs",
		label: "winfs",
		description:
			"Native Windows filesystem access for /mnt/<drive> paths. Operations: tree (directory overview), stat (file metadata), list (one directory), grep (content search), find (glob), read (file contents). Everything runs on the Windows side, so it is as fast as native Windows.",
		promptSnippet: "Native Windows filesystem access for /mnt/<drive> paths",
		promptGuidelines: [
			"Use winfs tree for a quick overview of a Windows directory (/mnt/c/...) instead of a recursive bash find.",
		],
		parameters: Type.Object({
			op: Type.Union(
				[
					Type.Literal("tree"),
					Type.Literal("stat"),
					Type.Literal("list"),
					Type.Literal("grep"),
					Type.Literal("find"),
					Type.Literal("read"),
				],
				{ description: "Operation to run" },
			),
			path: Type.String({ description: "Absolute path under /mnt/<drive>" }),
			pattern: Type.Optional(Type.String({ description: "Search pattern (grep) or glob (find)" })),
			maxDepth: Type.Optional(Type.Number({ description: "tree: maximum depth (default 3)" })),
			maxEntries: Type.Optional(Type.Number({ description: "tree: maximum entries (default 500)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of results" })),
		}),
		execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) => {
			const absolute = path.resolve(ctx?.cwd || baseCwd, params.path ?? ".");
			const win = winOf(absolute);
			if (!win) {
				return {
					content: [
						{
							type: "text",
							text: `winfs only handles Windows drive paths (/mnt/<drive>/...). "${absolute}" is not one.`,
						},
					],
					details: undefined,
				};
			}
			const bridge = await manager.ensure();
			if (!bridge) {
				return {
					content: [{ type: "text", text: "The native Windows helper is not available on this machine." }],
					details: undefined,
				};
			}
			try {
				if (params.op === "tree") {
					const result = await manager.call<any>("tree", {
						path: win,
						maxDepth: params.maxDepth ?? 3,
						maxEntries: params.maxEntries ?? 500,
						includeFiles: true,
					});
					const lines = (result?.entries ?? []).map(
						(entry: any) => `${"  ".repeat(entry.depth)}${entry.isDir ? `${entry.path}/` : entry.path}`,
					);
					return {
						content: [{ type: "text", text: lines.length ? lines.join("\n") : "(empty directory)" }],
						details: { count: lines.length },
					};
				}
				if (params.op === "stat") {
					const result = await manager.call<any>("stat", { path: win });
					const text = result?.exists
						? `${absolute}\n  type: ${result.isDir ? "directory" : "file"}\n  size: ${formatSize(result.size ?? 0)}\n  modified: ${new Date(result.mtimeMs ?? 0).toISOString()}`
						: `Path not found: ${absolute}`;
					return { content: [{ type: "text", text }], details: result };
				}
				if (params.op === "list") {
					const result = await manager.call<any>("list", { path: win });
					const entries = (result?.entries ?? []) as { name: string; isDir: boolean }[];
					entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
					const text = entries.length
						? entries.map((entry) => entry.name + (entry.isDir ? "/" : "")).join("\n")
						: "(empty directory)";
					return { content: [{ type: "text", text }], details: { count: entries.length } };
				}
				if (params.op === "grep") {
					const result = await manager.call<any>("grep", {
						path: win,
						pattern: params.pattern ?? "",
						limit: params.limit ?? DEFAULT_GREP_LIMIT,
					});
					const text = String(result?.output ?? "")
						.split("\n")
						.filter((line) => line.length > 0)
						.map((line) => {
							const separator = line.indexOf("\0");
							if (separator < 0) return line;
							const parsed = /^(\d+)([:\-])(.*)$/.exec(line.slice(separator + 1));
							if (!parsed) return line;
							return `${path.join(absolute, normalizeBridgePath(line.slice(0, separator)))}:${parsed[1]}: ${parsed[3]}`;
						})
						.join("\n");
					return {
						content: [{ type: "text", text: text || "No matches found" }],
						details: { count: result?.count ?? 0 },
					};
				}
				if (params.op === "find") {
					const result = await manager.call<any>("find", {
						path: win,
						pattern: params.pattern ?? "*",
						limit: params.limit ?? DEFAULT_FIND_LIMIT,
					});
					const files = String(result?.output ?? "")
						.split("\0")
						.filter((file) => file.length > 0)
						.map((file) => path.join(absolute, normalizeBridgePath(file)));
					const text = files.length ? files.join("\n") : "No files found matching pattern";
					return { content: [{ type: "text", text }], details: { count: files.length } };
				}
				if (params.op === "read") {
					const result = await manager.call<any>("read", { path: win });
					return {
						content: [{ type: "text", text: String(result?.data ?? "") }],
						details: { bytes: result?.bytes },
					};
				}
				return {
					content: [{ type: "text", text: `Unknown winfs op: ${params.op}` }],
					details: undefined,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `winfs failed: ${(error as Error).message}` }],
					details: undefined,
				};
			}
		},
	});

	// -- commands -----------------------------------------------------------

	pi.registerCommand("winfs-status", {
		description: "Show the Windows drive bridge status",
		handler: async (_args: string, ctx: any) => {
			const lines: string[] = [];
			lines.push(`winfs-bridge ${BRIDGE_VERSION}`);
			lines.push(`Windows mounts: ${MOUNTS.map((m) => `${m.mountPoint} -> ${m.winRoot}`).join(", ")}`);
			const bridge = await manager.ensure();
			lines.push(`Bridge: ${manager.status.state}${manager.status.detail ? ` (${manager.status.detail})` : ""}`);
			if (bridge) {
				lines.push(`Endpoint: ${manager.status.host}:${manager.status.port} (helper ${manager.status.version})`);
				lines.push(`Run /winfs-bench [dir] to compare 9p and native Windows speed.`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("winfs-bench", {
		description: "Benchmark WSL (9p) vs native Windows file access",
		handler: async (args: string, ctx: any) => {
			const requested = args.trim();
			const fallback = path.resolve(baseCwd);
			const target = requested ? path.resolve(baseCwd, requested) : fallback;
			const bridge = await manager.ensure();
			if (!bridge) {
				ctx.ui.notify("The native Windows helper is not available.", "error");
				return;
			}
			if (!toWinPath(target)) {
				ctx.ui.notify(`${target} is not on a Windows drive.`, "error");
				return;
			}
			const bench = await benchmark(bridge, target);
			if (!bench) {
				ctx.ui.notify("Nothing to benchmark in that directory.", "error");
				return;
			}
			ctx.ui.notify(
				`${bench.dir}\n  WSL via 9p   : ${bench.drvfsMs} ms (${bench.drvfsFiles} files)\n  Native Windows: ${bench.nativeMs} ms (${bench.nativeFiles} files)\n  Speed-up      : ${bench.ratio}x`,
				"info",
			);
		},
	});

	pi.on("session_shutdown", async () => {
		await manager.shutdown();
	});
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Compare WSL 9p access with native Windows access for the same directory. */
async function benchmark(
	bridge: Bridge,
	target: string,
): Promise<{
	dir: string;
	drvfsMs: number;
	nativeMs: number;
	ratio: number;
	drvfsFiles: number;
	nativeFiles: number;
} | null> {
	const dir = target.endsWith("/") ? target.slice(0, -1) : target;
	const win = toWinPath(dir);
	if (!win) return null;

	const started = Date.now();
	const drvfsFiles = await countFilesWsl(dir);
	const drvfsMs = Date.now() - started;

	const nativeStarted = Date.now();
	const result = await bridge.call("tree", { path: win, maxEntries: 200000, includeFiles: true });
	const nativeMs = Date.now() - nativeStarted;
	const nativeFiles = (result?.entries ?? []).filter((entry: any) => !entry.isDir).length;

	if (!drvfsFiles && !nativeFiles) return null;
	return {
		dir,
		drvfsMs,
		nativeMs,
		drvfsFiles,
		nativeFiles,
		ratio: nativeMs > 0 ? Math.round((drvfsMs / nativeMs) * 10) / 10 : drvfsMs,
	};
}

async function countFilesWsl(dir: string): Promise<number> {
	// Bounded so a benchmark on a huge drive does not hang the session.
	const MAX_FILES = 20000;
	const MAX_MS = 15000;
	let count = 0;
	const deadline = Date.now() + MAX_MS;
	const stack = [dir];
	while (stack.length > 0 && count < MAX_FILES && Date.now() < deadline) {
		const current = stack.pop()!;
		let entries: any[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) stack.push(path.join(current, entry.name));
			else count++;
		}
	}
	return count;
}
