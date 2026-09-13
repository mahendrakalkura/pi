#!/usr/bin/env bun
/**
 * Compile the Pi binary with Bun, optionally baking extensions into it.
 *
 * Replaces the `bun build --compile ...` step of `build:binary`. Without PI_BUNDLE_EXTENSIONS and
 * without an installed `packages/coding-agent/bundle/node_modules` the output is identical to upstream.
 *
 * - PI_BUNDLE_DIR (default: packages/coding-agent/bundle) holds a package.json whose dependencies are
 *   published Pi extension packages; every dependency that ships a `pi.extensions` manifest is bundled.
 *   It is also where third-party dependencies of local extensions are declared.
 * - PI_BUNDLE_EXTENSIONS names a directory of local `*.ts` / `*.js` extension sources; each top-level
 *   file is bundled, in name order.
 *
 * Everything found is imported statically from `src/bun/bundled-extensions.ts` and passed to `main()`
 * as an inline extension. `@earendil-works/*` and `typebox` imports from outside the repository are
 * aliased onto the copies already inside the bundle, so the binary holds exactly one instance of Pi.
 *
 * Usage: bun scripts/build-pi-binary.mjs                  compile the binary (cwd: packages/coding-agent)
 *        bun scripts/build-pi-binary.mjs --test <dir>     bundle the *.test.ts files of <dir> with the same
 *                                                         aliasing and run `bun test` on the result, so local
 *                                                         extension tests see the modules the binary contains
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const bundledModulePath = join(codingAgentDir, "src", "bun", "bundled-extensions.ts");
const outfile = join(codingAgentDir, "dist", "pi");
const defaultBundleDir = join(codingAgentDir, "bundle");
const EXTENSION_SOURCE = /\.(ts|js|mjs)$/;

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

/** Top-level extension source files of a directory, in name order, mirroring Pi's own directory discovery. */
function localExtensions(extensionsDir, bundleDir) {
	if (!existsSync(extensionsDir) || !statSync(extensionsDir).isDirectory()) {
		throw new Error(`PI_BUNDLE_EXTENSIONS is not a directory: ${extensionsDir}`);
	}
	// Copy under the bundle so bare third-party imports resolve through node_modules walking. A plugin
	// whose filter merely matches bare specifiers corrupts Bun's compile output, so the binary build must
	// not intercept these resolutions; the test build keeps externalDependencyPlugin instead.
	const localDir = join(bundleDir, ".local-extensions");
	rmSync(localDir, { force: true, recursive: true });
	mkdirSync(localDir, { recursive: true });
	return readdirSync(extensionsDir)
		.filter((name) => EXTENSION_SOURCE.test(name) && !name.endsWith(".d.ts"))
		.sort()
		.map((name) => {
			copyFileSync(join(extensionsDir, name), join(localDir, name));
			return { name: name.replace(EXTENSION_SOURCE, ""), path: join(localDir, name) };
		});
}

/** One entry group per dependency of the bundle manifest that is itself a Pi extension package. */
function packagedExtensions(bundleDir) {
	const manifestPath = join(bundleDir, "package.json");
	if (!existsSync(manifestPath)) {
		throw new Error(`PI_BUNDLE_DIR has no package.json: ${bundleDir}`);
	}
	const manifest = readJson(manifestPath);
	const dependencies = Object.keys(manifest.dependencies ?? {}).sort();
	const entries = dependencies.flatMap((dependency) => manifestEntries(join(bundleDir, "node_modules", dependency)));

	const missing = entries.filter((entry) => !existsSync(entry.path));
	if (missing.length > 0) {
		throw new Error(`Bundled extension entries do not exist (run npm install in ${bundleDir}):\n${missing.map((entry) => `  ${entry.path}`).join("\n")}`);
	}
	return entries;
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

function isInside(root, path) {
	const rel = relative(root, path);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function aliasPlugin(bundleDir) {
	const aliases = codingAgentPathAliases();
	return {
		name: "pi-alias-external-extension-imports",
		setup(build) {
			build.onResolve({ filter: ALIASED_IMPORT }, (args) => {
				// Monorepo sources already resolve through the workspace. Extension sources outside the repository
				// and packages installed under the bundle directory would otherwise pull in their own copies.
				if (!args.importer) return undefined;
				const importer = realpathSync(args.importer);
				if (isInside(repoRoot, importer) && !isInside(bundleDir, importer)) return undefined;

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
/** Local extension sources live outside any node_modules tree; the test bundle resolves their bare imports
 * (third-party libraries) against the bundle directory first and the coding-agent package second. This is
 * safe under target "bun" but corrupts compile output, so the binary build resolves them by copying instead. */
function externalDependencyPlugin(bundleDir) {
	const BARE_SPECIFIER = /^(?![./]|node:|bun:|bun$|@earendil-works\/|typebox(\/|$)|@sinclair\/typebox(\/|$))[^:]+$/;
	return {
		name: "pi-external-extension-dependencies",
		setup(build) {
			build.onResolve({ filter: BARE_SPECIFIER }, (args) => {
				if (!args.importer || isInside(repoRoot, realpathSync(args.importer))) return undefined;
				for (const root of [bundleDir, codingAgentDir]) {
					try {
						return { path: Bun.resolveSync(args.path, root) };
					} catch {}
				}
				throw new Error(`Cannot resolve ${args.path} imported by ${args.importer}; declare it in ${join(bundleDir, "package.json")}`);
			});
		},
	};
}

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

const bundleDir = resolve(process.env.PI_BUNDLE_DIR ?? defaultBundleDir);

// --test <dir>: bundle the test files, then run them in place inside the bundle directory.
const testFlag = process.argv.indexOf("--test");
if (testFlag !== -1) {
	const testsDir = resolve(process.argv[testFlag + 1] ?? "");
	if (!existsSync(testsDir) || !statSync(testsDir).isDirectory()) {
		throw new Error(`--test expects a directory of *.test.ts files: ${testsDir}`);
	}
	const testFiles = readdirSync(testsDir)
		.filter((name) => /\.test\.(ts|js|mjs)$/.test(name))
		.sort()
		.map((name) => join(testsDir, name));
	if (testFiles.length === 0) throw new Error(`No test files in ${testsDir}`);

	const outdir = join(bundleDir, ".tests");
	rmSync(outdir, { force: true, recursive: true });
	mkdirSync(outdir, { recursive: true });
	const built = await Bun.build({
		entrypoints: testFiles,
		external: ["bun:test"],
		outdir,
		plugins: [aliasPlugin(bundleDir), externalDependencyPlugin(bundleDir), pinRequireResolvePlugin(bundleDir)],
		target: "bun",
	});
	if (!built.success) {
		for (const log of built.logs) console.error(String(log));
		process.exit(1);
	}
	const run = Bun.spawnSync(["bun", "test", outdir], { stderr: "inherit", stdout: "inherit" });
	rmSync(outdir, { force: true, recursive: true });
	process.exit(run.exitCode ?? 1);
}
const extensionsDir = process.env.PI_BUNDLE_EXTENSIONS ? resolve(process.env.PI_BUNDLE_EXTENSIONS) : undefined;
const bundling = extensionsDir !== undefined || existsSync(join(bundleDir, "node_modules"));
const entries = bundling ? [...(extensionsDir ? localExtensions(extensionsDir, bundleDir) : []), ...packagedExtensions(bundleDir)] : [];
if (bundling) {
	console.log(`Bundling ${entries.length} extensions (packages from ${bundleDir}${extensionsDir ? `, sources from ${extensionsDir}` : ""}):`);
	for (const entry of entries) console.log(`  ${entry.name}  ${entry.path}`);
}

const result = await Bun.build({
	compile: { autoloadBunfig: false, outfile },
	entrypoints: [join(codingAgentDir, "src", "bun", "cli.ts"), join(codingAgentDir, "src", "utils", "image-resize-worker.ts")],
	plugins: bundling ? [aliasPlugin(bundleDir), pinRequireResolvePlugin(bundleDir), bundledExtensionsPlugin(entries)] : [],
	target: "bun",
});

if (!result.success) {
	for (const log of result.logs) console.error(String(log));
	process.exit(1);
}
console.log(`Wrote ${outfile}`);
