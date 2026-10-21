// Integration test for the winfs-bridge Pi extension.
//
// Run with: npm test   (or: node tests/run.mjs)
//
// Requires WSL2 with a Windows drive mounted at /mnt/<drive>. The test creates
// its own scratch directory there and cleans up afterwards.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createLoader, fakePi, fakeContext, fixtureDir } from "./_env.mjs";

// A 1x1 red PNG, used to exercise image MIME sniffing over the bridge.
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

let failures = 0;

function check(label, condition, detail) {
	if (condition) {
		console.log(`  ok   ${label}`);
	} else {
		failures++;
		console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
	}
}

const loader = await createLoader();
const mod = await loader.loadExtension();
const { api, tools, commands, handlers } = fakePi();
mod(api);

if (tools.size === 0) {
	console.log("Extension did not register anything.");
	console.log("This usually means it is not running inside WSL2 with drvfs mounts,");
	console.log("or WINFS_BRIDGE=0 / ~/.pi/agent/winfs-bridge.disabled is set.");
	process.exit(1);
}

// `write` is deliberately not taken over by winfs-bridge (another extension
// owns a richer version of it), so fall back to Pi's built-in definition.
const piModule = await loader.piModule();
if (!tools.has("write")) {
	tools.set("write", piModule.createWriteToolDefinition(process.cwd()));
}

console.log("tools:", [...tools.keys()].join(", "));
console.log("commands:", [...commands.keys()].join(", "));

const ctx = fakeContext();
for (const handler of handlers.get("session_start") || []) await handler({}, ctx);

const call = async (name, params) => {
	const tool = tools.get(name);
	const result = await tool.execute("test-call", params, undefined, undefined, ctx);
	const text = (result.content ?? []).map((c) => c.text ?? `[${c.type}]`).join("\n");
	return { text, details: result.details };
};

// -- fixtures ---------------------------------------------------------------

const TARGET = fixtureDir();
rmSync(TARGET, { recursive: true, force: true });
mkdirSync(path.join(TARGET, "sub"), { recursive: true });
writeFileSync(path.join(TARGET, "a.txt"), "hello-from-ntfs\n", "utf8");
writeFileSync(path.join(TARGET, "sub", "b.txt"), "nested\n", "utf8");
writeFileSync(path.join(TARGET, "pic.png"), PNG_1X1);

const section = (title) => console.log(`\n=== ${title} ===`);

try {
	section("read");
	const read = await call("read", { path: `${TARGET}/a.txt` });
	console.log(read.text);
	check("reads file content", read.text.includes("hello-from-ntfs"));

	section("ls");
	const ls = await call("ls", { path: TARGET });
	console.log(ls.text);
	check("lists entries", ls.text.includes("a.txt") && ls.text.includes("sub"));

	section("write + read back");
	const write = await call("write", { path: `${TARGET}/c.txt`, content: "hello from pi\nline2\n" });
	console.log(write.text);
	check("write succeeds", /wrote|created|updated/i.test(write.text) || write.text.length > 0);
	const readBack = await call("read", { path: `${TARGET}/c.txt` });
	check("reads back written content", readBack.text.includes("line2"), readBack.text);

	section("edit");
	const edit = await call("edit", {
		path: `${TARGET}/c.txt`,
		edits: [{ oldText: "line2", newText: "line2-edited" }],
	});
	console.log(edit.text);
	const afterEdit = await call("read", { path: `${TARGET}/c.txt` });
	check("edit applied", afterEdit.text.includes("line2-edited"), afterEdit.text);

	section("edit (unique match error path)");
	try {
		await call("edit", {
			path: `${TARGET}/c.txt`,
			edits: [{ oldText: "nope-not-there", newText: "x" }],
		});
		check("missing oldText rejects", false, "expected an error, none thrown");
	} catch (error) {
		const line = String(error.message).split("\n")[0];
		console.log("expected error:", line);
		check("missing oldText rejects", line.length > 0);
	}

	section("find");
	const find = await call("find", { pattern: "*.txt", path: TARGET });
	console.log(find.text);
	check("find matches txt files", find.text.includes("a.txt"));

	section("find with path pattern");
	const findSub = await call("find", { pattern: "sub/*.txt", path: TARGET });
	console.log(findSub.text);
	check("find matches path pattern", findSub.text.includes("b.txt"), findSub.text);

	section("grep");
	const grep = await call("grep", { pattern: "edited", path: TARGET });
	console.log(grep.text);
	check("grep finds content", grep.text.includes("c.txt"));

	section("grep with context");
	const grepCtx = await call("grep", { pattern: "edited", path: TARGET, context: 1 });
	console.log(grepCtx.text);
	check("grep context returns lines", grepCtx.text.length > 0);

	section("grep literal + ignoreCase");
	const grepLiteral = await call("grep", {
		pattern: "EDITED",
		path: TARGET,
		ignoreCase: true,
		literal: true,
	});
	console.log(grepLiteral.text);
	check("grep case-insensitive", grepLiteral.text.includes("c.txt"), grepLiteral.text);

	section("winfs tree");
	const tree = await call("winfs", { op: "tree", path: TARGET, maxDepth: 2 });
	console.log(tree.text);
	check("tree lists nested entry", tree.text.includes("b.txt"));

	section("winfs stat");
	const stat = await call("winfs", { op: "stat", path: `${TARGET}/a.txt` });
	console.log(stat.text);
	check("stat reports size", /\d+/.test(stat.text));

	section("winfs list");
	const list = await call("winfs", { op: "list", path: TARGET });
	console.log(list.text);
	check("winfs list works", list.text.includes("a.txt"));

	section("winfs find");
	const winFind = await call("winfs", { op: "find", path: TARGET, pattern: "*.txt" });
	console.log(winFind.text);
	check("winfs find works", winFind.text.includes("a.txt"));

	section("winfs grep");
	const winGrep = await call("winfs", { op: "grep", path: TARGET, pattern: "edited" });
	console.log(winGrep.text);
	check("winfs grep works", winGrep.text.includes("c.txt"));

	section("local file (not on a Windows drive) still works");
	const localRead = await call("read", { path: path.join(process.env.HOME ?? ".", ".pi", "agent", "settings.json") });
	console.log(localRead.text.slice(0, 100));
	check("local read returns something", localRead.text.length > 0);

	section("local ls");
	const localLs = await call("ls", { path: process.cwd() });
	check("local ls works", localLs.text.length > 0);

	section("local grep");
	const localGrep = await call("grep", { pattern: "winfs", path: process.cwd() });
	console.log(localGrep.text.split("\n").slice(0, 5).join("\n"));
	check("local grep returns", localGrep.text.length > 0);

	section("image read (mime sniffing)");
	const image = await call("read", { path: `${TARGET}/pic.png` });
	console.log(image.text);
} finally {
	for (const handler of handlers.get("session_shutdown") || []) await handler({}, ctx);
	try {
		rmSync(TARGET, { recursive: true, force: true });
	} catch {
		/* leave it for inspection */
	}
}

console.log(failures === 0 ? "\nDONE - all checks passed" : `\nDONE - ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
