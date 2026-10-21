// Benchmark: compare drvfs/9p against the bridge, end to end, through the
// extension's real tool implementations.
//
// Usage: npm run bench [path]
// Default target is ~/AppData/Local on the C: drive (metadata-heavy, thousands
// of files). Pass a smaller directory if that is too slow on your machine.
import { createLoader, fakePi, fakeContext } from "./_env.mjs";

const loader = await createLoader();
const mod = await loader.loadExtension();
const { api, commands, handlers } = fakePi();
mod(api);

const ctx = fakeContext();
for (const handler of handlers.get("session_start") || []) await handler({}, ctx);

const status = commands.get("winfs-status");
if (status) {
	console.log("--- /winfs-status ---");
	try {
		await status.handler("", ctx);
	} catch (error) {
		console.log("ERR", error);
	}
}

const target = process.argv[2] || (process.env.USER ? `/mnt/c/Users/${process.env.USER}/AppData/Local` : "/mnt/c");
const bench = commands.get("winfs-bench");
if (!bench) {
	console.log("winfs-bench command not registered (extension inactive?).");
	process.exit(1);
}

console.log(`\n--- /winfs-bench ${target} ---`);
try {
	await bench.handler(target, ctx);
} catch (error) {
	console.log("ERR", error);
}

for (const handler of handlers.get("session_shutdown") || []) await handler({}, ctx);
process.exit(0);
