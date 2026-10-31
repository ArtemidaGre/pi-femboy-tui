/**
 * link-check.mjs — every named import in the femboy extension must resolve to a
 * real runtime export. Catches `import { homedir } from "node:path"` (it lives
 * in node:os) and `import { currentOutfit } from "./sprites"` (it lives in
 * ./vibe) — mistakes that type-check clean under jiti and only explode when a
 * component renders. Type-only specifiers are skipped because they are erased.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createJiti } from "jiti";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Paths resolve from tools/, not the caller's cwd, so `npm run check` works from anywhere.
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../extensions");

const jiti = createJiti(import.meta.url, { interop: true });
const dir = SRC;
let bad = 0;

for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
	const src = readFileSync(`${dir}/${file}`, "utf8");
	const re = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g;
	let m;
	while ((m = re.exec(src))) {
		if (m[1]) continue; // whole clause is type-only
		const spec = m[3];
		const target = spec.startsWith("./") ? `${dir}/${spec.slice(2)}` : spec;
		let mod;
		try {
			mod = await jiti.import(target);
		} catch (error) {
			console.log(`UNRESOLVED ${file}: from "${spec}" -> ${String(error.message).split("\n")[0]}`);
			bad++;
			continue;
		}
		for (const raw of m[2].split(",")) {
			const trimmed = raw.replace(/\/\*[\s\S]*?\*\//g, "").trim();
			if (!trimmed || trimmed.startsWith("type ")) continue;
			const name = trimmed.split(" as ")[0].trim();
			if (!name) continue;
			if (mod[name] === undefined) {
				console.log(`MISSING ${file}: { ${name} } from "${spec}" -> not exported`);
				bad++;
			}
		}
	}
}

console.log(bad ? `${bad} problem(s)` : "all imports resolve to real exports");
process.exit(bad ? 1 : 0);
