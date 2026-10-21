// Fallback check: kill the Windows helper, then confirm the next read still
// succeeds (either by restarting the bridge or by falling back to 9p).
//
// Usage: npm run selftest
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createLoader, fakePi, fakeContext, fixtureDir } from "./_env.mjs";

const loader = await createLoader();
const mod = await loader.loadExtension();
const { api, tools, handlers } = fakePi();
mod(api);

const ctx = fakeContext();
for (const handler of handlers.get("session_start") || []) await handler({}, ctx);

// Stop every Windows-side helper process before reading.
const kill = spawnSync("/mnt/c/Windows/System32/taskkill.exe", ["/F", "/IM", "python.exe"], {
	encoding: "utf8",
});
console.log("taskkill:", (kill.stdout || "").trim().split("\n")[0] || kill.error?.message || "no output");

const target = path.join(fixtureDir(), "a.txt");
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, "hello-from-ntfs\n", "utf8");

const read = await tools.get("read").execute("selftest", { path: target }, undefined, undefined, ctx);
const text = (read.content ?? []).map((c) => c.text ?? "").join("\n");
console.log("read after bridge kill:", JSON.stringify(text));

for (const handler of handlers.get("session_shutdown") || []) await handler({}, ctx);
process.exit(text.includes("hello-from-ntfs") ? 0 : 1);
