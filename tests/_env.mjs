// Shared test harness: locates the local Pi installation and loads the
// extension with jiti, providing a fake ExtensionAPI.
//
// Everything here is resolved dynamically so the tests work on any machine
// with Pi installed — no absolute paths baked in.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const EXT = path.join(HERE, "..", "extensions", "winfs-bridge", "index.ts");

/** Candidate Pi agent directories, most specific first. */
function agentDirCandidates() {
	const out = [];
	if (process.env.PI_CODING_AGENT_DIR) out.push(process.env.PI_CODING_AGENT_DIR);
	out.push(path.join(os.homedir(), ".pi", "agent"));
	return out;
}

/** Locate `@earendil-works/pi-coding-agent` inside a managed Pi install. */
function findManagedInstall() {
	const roots = [];
	if (process.env.PI_MANAGED_INSTALL_ROOT) roots.push(process.env.PI_MANAGED_INSTALL_ROOT);
	for (const dir of agentDirCandidates()) roots.push(path.join(dir, "install"));

	for (const root of roots) {
		const versionFile = path.join(root, "current-version");
		let version = null;
		if (existsSync(versionFile)) {
			try {
				version = readFileSync(versionFile, "utf8").trim();
			} catch {
				/* ignore */
			}
		}
		const releases = [];
		if (version) releases.push(path.join(root, "releases", version));
		releases.push(path.join(root, "releases"));
		for (const release of releases) {
			const pkg = path.join(release, "node_modules", "@earendil-works", "pi-coding-agent");
			if (existsSync(path.join(pkg, "dist", "index.js"))) {
				return { agentPkg: pkg, releaseDir: release };
			}
			// `releases` itself: pick the highest version directory present.
			if (release === path.join(root, "releases") && existsSync(release)) {
				for (const entry of readdirSafe(release).sort().reverse()) {
					const candidate = path.join(release, entry, "node_modules", "@earendil-works", "pi-coding-agent");
					if (existsSync(path.join(candidate, "dist", "index.js"))) {
						return { agentPkg: candidate, releaseDir: path.join(release, entry) };
					}
				}
			}
		}
	}
	return null;
}

function readdirSafe(dir) {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function resolveJiti(install) {
	const candidates = [];
	if (install) {
		candidates.push(path.join(install.releaseDir, "node_modules", "jiti", "lib", "jiti.mjs"));
	}
	for (const dir of agentDirCandidates()) {
		candidates.push(path.join(dir, "install", "releases"));
	}
	candidates.push(path.join(HERE, "..", "node_modules", "jiti", "lib", "jiti.mjs"));
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	// Dev dependency installed locally: resolve through Node itself.
	try {
		return import.meta.resolve("jiti/lib/jiti.mjs").replace(/^file:\/\//, "");
	} catch {
		/* ignore */
	}
	return null;
}

function findTypebox(install) {
	const candidates = install
		? [
				path.join(install.agentPkg, "node_modules", "typebox", "build", "index.mjs"),
				path.join(install.releaseDir, "node_modules", "typebox", "build", "index.mjs"),
			]
		: [];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** Build a jiti instance aliased to the local Pi install. */
export async function createLoader() {
	const install = findManagedInstall();
	if (!install) {
		throw new Error(
			"Could not find @earendil-works/pi-coding-agent. Install Pi (https://pi.dev) or set PI_MANAGED_INSTALL_ROOT.",
		);
	}
	const jitiPath = resolveJiti(install);
	if (!jitiPath) throw new Error("Could not find jiti (bundled with Pi, or `npm install` this repo).");

	const { createJiti } = await import(pathToFileURL(jitiPath).href);
	const typebox = findTypebox(install);
	const alias = {
		"@earendil-works/pi-coding-agent": `${path.join(install.agentPkg, "dist", "index.js")}`,
	};
	if (typebox) alias.typebox = typebox;

	const jiti = createJiti(pathToFileURL(path.join(HERE, "_env.mjs")).href, {
		alias,
		interopDefault: true,
	});

	return {
		jiti,
		install,
		/** Import the extension's default export. */
		async loadExtension() {
			return jiti.import(EXT, { default: true });
		},
		/** Import a helper from the Pi package itself. */
		async piModule() {
			return jiti.import(path.join(install.agentPkg, "dist", "index.js"));
		},
	};
}

/** Minimal stand-in for the fields of ExtensionAPI the extension touches. */
export function fakePi() {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const api = {
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerCommand(name, spec) {
			commands.set(name, spec);
		},
		registerShortcut() {},
		registerFlag() {},
		registerToolRenderer() {},
		registerMcpServer() {},
		on(event, handler) {
			const list = handlers.get(event) || [];
			list.push(handler);
			handlers.set(event, list);
		},
		getFlag() {
			return undefined;
		},
		events: { emit() {}, on() {} },
	};
	return { api, tools, commands, handlers };
}

export function fakeContext(cwd = process.cwd()) {
	return {
		cwd,
		model: undefined,
		ui: {
			notify: (message, type) => console.log(`[notify:${type ?? "info"}] ${message}`),
			setStatus: (key, value) => console.log(`[status] ${key} = ${value}`),
			confirm: async () => true,
		},
	};
}

/** Path of the scratch directory used by the tests, on a Windows drive. */
export function fixtureDir() {
	if (process.env.WINFS_TEST_DIR) return process.env.WINFS_TEST_DIR;
	const user = process.env.USER ?? process.env.LOGNAME ?? "user";
	return `/mnt/c/Users/${user}/winfs-bridge-test`;
}
