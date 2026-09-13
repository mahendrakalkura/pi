#!/usr/bin/env bun
/**
 * Compile the Pi binary with Bun, optionally baking extensions into it.
 *
 * Replaces the `bun build --compile ...` step of `build:binary`. Without PI_BUNDLE_DIR the output is
 * identical to upstream. With PI_BUNDLE_DIR set to a directory holding a package.json, every module
 * listed in that manifest's `pi.extensions`, plus every dependency that ships its own `pi.extensions`
 * manifest, is imported statically from `src/bun/bundled-extensions.ts` and passed to `main()` as an
 * inline extension. Their `@earendil-works/*` and `typebox` imports are aliased onto the copies already
 * inside the bundle, so the binary holds exactly one instance of Pi.
 *
 * Usage: bun scripts/build-pi-binary.mjs   (cwd: packages/coding-agent)
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const bundledModulePath = join(codingAgentDir, "src", "bun", "bundled-extensions.ts");
const outfile = join(codingAgentDir, "dist", "pi");

// Specifiers that must resolve to the bundle's own copy rather than to a second install next to an extension.
const ALIASED_IMPORT = /^(@earendil-works\/|typebox(\/|$)|@sinclair\/typebox(\/|$))/;
const CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

/** Entries declared by a package.json `pi.extensions` manifest, resolved against the package directory. */
function manifestEntries(packageDir) {
	const manifestPath = join(packageDir, "package.json");
	if (!existsSync(manifestPath)) return [];
	const manifest = readJson(manifestPath);
	const entries = manifest.pi?.extensions;
	if (!Array.isArray(entries)) return [];
	return entries.map((entry) => ({
		name: manifest.name ?? basename(packageDir),
		path: resolve(packageDir, entry),
	}));
}

/** Local manifest entries first, then one group per dependency that is itself a Pi extension package. */
function collectBundledExtensions(bundleDir) {
	const manifestPath = join(bundleDir, "package.json");
	if (!existsSync(manifestPath)) {
		throw new Error(`PI_BUNDLE_DIR has no package.json: ${bundleDir}`);
	}
	const manifest = readJson(manifestPath);
	const local = manifestEntries(bundleDir).map((entry) => ({
		name: basename(entry.path).replace(/\.(ts|js|mjs)$/, ""),
		path: entry.path,
	}));

	const dependencies = Object.keys(manifest.dependencies ?? {}).sort();
	const packaged = dependencies.flatMap((dependency) => manifestEntries(join(bundleDir, "node_modules", dependency)));

	const missing = [...local, ...packaged].filter((entry) => !existsSync(entry.path));
	if (missing.length > 0) {
		throw new Error(`Bundled extension entries do not exist:\n${missing.map((entry) => `  ${entry.path}`).join("\n")}`);
	}
	return [...local, ...packaged];
}

/** Source of the replacement `bundled-extensions.ts` module. */
function bundledModuleSource(entries) {
	const imports = entries.map((entry, index) => `import factory${index} from ${JSON.stringify(entry.path)};`);
	const items = entries.map((entry, index) => `\t{ name: ${JSON.stringify(entry.name)}, factory: factory${index} },`);
	return [
		'import type { InlineExtension } from "../core/extensions/types.ts";',
		...imports,
		"",
		"export const bundledExtensions: InlineExtension[] = [",
		...items,
		"];",
		"",
	].join("\n");
}

/** tsconfig `paths` for the coding-agent package, so external importers see the same modules the bundle already contains. */
function codingAgentPathAliases() {
	const paths = readJson(join(repoRoot, "tsconfig.json")).compilerOptions?.paths ?? {};
	const aliases = [];
	for (const [pattern, targets] of Object.entries(paths)) {
		if (!pattern.startsWith(CODING_AGENT_PACKAGE)) continue;
		aliases.push({ pattern, target: resolve(repoRoot, targets[0]) });
	}
	// Exact patterns win over the wildcard.
	return aliases.sort((a, b) => Number(a.pattern.includes("*")) - Number(b.pattern.includes("*")));
}

function firstExisting(candidates) {
	return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function resolveCodingAgentImport(specifier, aliases) {
	for (const { pattern, target } of aliases) {
		if (!pattern.includes("*")) {
			if (specifier === pattern) return target;
			continue;
		}
		const prefix = pattern.slice(0, pattern.indexOf("*"));
		if (!specifier.startsWith(prefix)) continue;
		const rest = specifier.slice(prefix.length);
		const base = target.replace("*", rest);
		const found = firstExisting([base, `${base}.ts`, join(base, "index.ts")]);
		if (found) return found;
	}
	throw new Error(`Cannot map ${specifier} onto the coding-agent sources`);
}

function isInsideRepo(path) {
	const rel = relative(repoRoot, path);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function aliasPlugin() {
	const aliases = codingAgentPathAliases();
	return {
		name: "pi-alias-external-extension-imports",
		setup(build) {
			build.onResolve({ filter: ALIASED_IMPORT }, (args) => {
				// Files inside the monorepo already resolve through the workspace; only outside importers need help.
				if (!args.importer || isInsideRepo(realpathSync(args.importer))) return undefined;

				let specifier = args.path.replace(/^@sinclair\/typebox/, "typebox");
				if (specifier === CODING_AGENT_PACKAGE || specifier.startsWith(`${CODING_AGENT_PACKAGE}/`)) {
					return { path: resolveCodingAgentImport(specifier, aliases) };
				}
				return { path: Bun.resolveSync(specifier, codingAgentDir) };
			});
		},
	};
}

/**
 * Extension packages sometimes locate sibling packages on disk with `require.resolve("pkg/file")` from a
 * `createRequire(import.meta.url)`; inside the binary `import.meta.url` is virtual, so pin each static
 * call to the absolute path it resolves to at build time. Only files under the bundle directory are touched.
 */
function pinRequireResolvePlugin(bundleDir) {
	const escaped = bundleDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const STATIC_REQUIRE_RESOLVE = /require\.resolve\((['"])([^'"]+)\1\)/g;
	return {
		name: "pi-pin-require-resolve",
		setup(build) {
			build.onLoad({ filter: new RegExp(`^${escaped}/.*\\.(js|mjs|cjs|ts)$`) }, (args) => {
				const source = readFileSync(args.path, "utf8");
				if (!STATIC_REQUIRE_RESOLVE.test(source)) return undefined;
				STATIC_REQUIRE_RESOLVE.lastIndex = 0;
				// Optional packages that are absent at build time keep the original call, which fails at runtime exactly as it did before.
				const contents = source.replace(STATIC_REQUIRE_RESOLVE, (match, _quote, specifier) => {
					try {
						return JSON.stringify(Bun.resolveSync(specifier, dirname(args.path)));
					} catch {
						return match;
					}
				});
				return { contents, loader: args.path.endsWith(".ts") ? "ts" : "js" };
			});
		},
	};
}

function bundledExtensionsPlugin(entries) {
	return {
		name: "pi-bundled-extensions",
		setup(build) {
			build.onLoad({ filter: new RegExp(`${bundledModulePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }, () => ({
				contents: bundledModuleSource(entries),
				loader: "ts",
			}));
		},
	};
}

const bundleDir = process.env.PI_BUNDLE_DIR ? resolve(process.env.PI_BUNDLE_DIR) : undefined;
const entries = bundleDir ? collectBundledExtensions(bundleDir) : [];
if (bundleDir) {
	console.log(`Bundling ${entries.length} extensions from ${bundleDir}:`);
	for (const entry of entries) console.log(`  ${entry.name}  ${entry.path}`);
}

const result = await Bun.build({
	compile: { autoloadBunfig: false, outfile },
	entrypoints: [join(codingAgentDir, "src", "bun", "cli.ts"), join(codingAgentDir, "src", "utils", "image-resize-worker.ts")],
	plugins: bundleDir ? [aliasPlugin(), pinRequireResolvePlugin(bundleDir), bundledExtensionsPlugin(entries)] : [],
	target: "bun",
});

if (!result.success) {
	for (const log of result.logs) console.error(String(log));
	process.exit(1);
}
console.log(`Wrote ${outfile}`);
