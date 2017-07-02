#!/usr/bin/env node
/* eslint-disable no-console */

const detective = require("detective");
const {minify} = require("uglify-es");
const nodeLibs = require("node-libs-browser");
const path = require("path");
const fs = require("./async-fs");
const {all, tryAll} = require("./async-util");

const preloadRegex = /\/\/#[ \t]+preload[ \t]+(\S*)/g;
const envRegex = /process.env.NODE_ENV/g;
let cache = {files: {}, packages: {}};

const sDeps = "/deps";
const sCode = "/code";

const env = process.env.NODE_ENV; //eslint-disable-line no-process-env
const minifyOptions = {
	compress: {
		dead_code: true, //eslint-disable-line camelcase
	},
};

class JSONSet extends Set {
	map(mapper) {
		const result = new JSONSet();
		this.forEach((val) => result.add(mapper(val)));
		return result;
	}
	filter(filterer) {
		const result = new JSONSet();
		this.forEach((val) => filterer(val) ? result.add(val) : 0);
		return result;
	}
	addMany(iterable) {
		for (const item of iterable) {
			this.add(item);
		}
	}
	toJSON() {
		return [...this];
	}
}

function addPath(data, pathName) {
	pathName = pathName.substr(1);
	if (pathName === "") return data;
	const parts = pathName.split("/");
	for (const part of parts) {
		if (!(part in data)) {
			data[part] = {};
		}
		data = data[part];
	}
	return data;
}

function resolveFileRelative(root, file, next) {
	if (next[0] === "/") {
		next = root + next;
	} else {
		const dir = path.dirname(file);
		next = path.resolve(dir, next);
	}
	return require.resolve(next);
}

function getPackageRoot(absFile) {
	const parts = absFile.replace(/\\/g, "/").split("/");
	return parts.slice(0, parts.findIndex((x) => x === "node_modules") + 2).join("/");
}

function isPackage(name) {
	return !(name[0] === "/" || name.startsWith("./") || name.startsWith("../"));
}

function absoluteToRelative(root, file) {
	const rel = path.relative(root, file).replace(/\\/g, "/");
	if (rel.startsWith("..")) throw new Error("path outside webroot");
	return "/" + rel;
}

function parseDeps(code) {
	const deps = new Set(detective(code));
	let match;
	while ((match = preloadRegex.exec(code))) {
		const [, dep] = match;
		deps.add(dep.trim());
	}
	return [...deps];
}

async function getDependencies(src) {
	try {
		const code = (await fs.readFile(src)).toString();
		return {code, deps: parseDeps(code)};
	} catch (error) {
		console.error(`ERROR: ${error.message}`);
		return {};
	}
}

async function getJSON(file) {
	try {
		return JSON.stringify(JSON.parse(await fs.readFile(file)));
	} catch (error) {
		console.error("file read error", error);
		return "";
	}
}

async function parsePackage(packName, absRoot, prevFile, curFile) {
	const absFile = resolveFileRelative(absRoot, prevFile, curFile);
	const relFile = packName + absoluteToRelative(absRoot, absFile);
	if (relFile in cache.files) {
		return relFile;
	}

	cache.packages[packName].dirty = true;
	const obj = cache.files[relFile] = {};

	//don't parse deps or minify json files
	if (relFile.endsWith(".json")) {
		obj[sCode] = await getJSON(absFile);
		return relFile;
	}

	const data = await getDependencies(absFile);
	const code = data.code.replace(envRegex, env);
	const minified = minify(code, minifyOptions);
	obj[sCode] = minified.code;
	obj[sDeps] = new JSONSet();

	const jobs = [];
	for (const dep of data.deps) {
		if (!isPackage(dep)) {
			//normal dependency
			jobs.push(parsePackage(packName, absRoot, absFile, dep));
		} else {
			//node_module
			const packName = dep.split("/")[0];
			jobs.push(buildPackage(packName, dep));
		}
	}

	const results = await tryAll(jobs);
	for (const result of results) {
		if (result.error) {
			console.error(`ERROR: ${result.error.message}`);
		} else {
			obj[sDeps].add(result.value);
		}
	}

	return relFile;
}

async function buildPackage(name, entry) {
	let absFile;
	if (name in nodeLibs) {
		if (!nodeLibs[name]) {
			throw new Error(`'${name}' does not have a browser implementation`);
		}
		absFile = nodeLibs[name];
	} else {
		absFile = require.resolve(entry);
	}
	const absRoot = getPackageRoot(absFile);
	const relFile = absoluteToRelative(absRoot, absFile);
	if (!(name in cache.packages)) {
		const absMainEntry = require.resolve(absRoot);
		const mainEntry = absoluteToRelative(absRoot, absMainEntry);

		cache.packages[name] = {
			entry: mainEntry,
			dirty: false,
		};
	}

	await parsePackage(name, absRoot, null, relFile);

	return name + relFile;
}

async function parseTree(absRoot, prevFile, curFile) {
	const absFile = resolveFileRelative(absRoot, prevFile, curFile);
	const relFile = absoluteToRelative(absRoot, absFile);
	if (relFile in cache.files || !relFile.endsWith(".js")) {
		return relFile;
	}

	const obj = cache.files[relFile] = {};
	const data = await getDependencies(absFile);
	obj[sDeps] = new JSONSet();

	const jobs = [];
	for (const dep of data.deps) {
		if (!isPackage(dep)) {
			//normal dependency
			jobs.push(parseTree(absRoot, absFile, dep));
		} else {
			//node_module
			const packName = dep.split("/")[0];
			jobs.push(buildPackage(packName, dep));
		}
	}

	const results = await tryAll(jobs);
	for (const result of results) {
		if (result.error) {
			console.error(`ERROR: ${result.error.message}`);
		} else {
			obj[sDeps].add(result.value);
		}
	}

	return relFile;
}

async function buildCore(absRoot, entry) {
	await parseTree(absRoot, null, entry);
}

function rebuildCacheAndVFS(absRoot, absDir, entries) {
	let outputDir = absoluteToRelative(absRoot, absDir);
	outputDir += outputDir.endsWith("/") ? "" : "/";

	const staleFiles = new Set(Object.keys(cache.files));

	const clonedCache = {files: {}, packages: {}};
	const packages = {};
	const vfs = {files: {}, packages: {}, outputDir};

	for (const entry of entries) {
		const absFile = resolveFileRelative(absRoot, null, entry);
		const relFile = absoluteToRelative(absRoot, absFile);

		const stack = [relFile];
		while (stack.length > 0) {
			const curFile = stack.pop();
			if (curFile in clonedCache.files) {
				continue;
			}

			staleFiles.delete(curFile);

			clonedCache.files[curFile] = cache.files[curFile];
			const minDeps = cache.files[curFile][sDeps].map((name) => {
				return name.startsWith("/") ? name : name.split("/")[0];
			});

			if (curFile.startsWith("/")) {
				const pathObj = addPath(vfs.files, curFile);
				pathObj[sDeps] = minDeps;
			} else {
				const parts = curFile.split("/");
				const name = parts.shift();
				const relFile = "/" + parts.join("/");
				const filtered = minDeps.filter((name) => !name.startsWith("/"));
				filtered.delete(name);

				if (!(name in vfs.packages)) {
					vfs.packages[name] = {[sDeps]: new JSONSet()};
					clonedCache.packages[name] = cache.packages[name];
					packages[name] = {
						entry: cache.packages[name].entry,
						files: {},
						[sDeps]: vfs.packages[name][sDeps],
						dirty: cache.packages[name].dirty,
					};
					clonedCache.packages[name].dirty = false;
				}

				const sharedDepsSet = vfs.packages[name][sDeps];
				sharedDepsSet.addMany(filtered);

				const pathObj = addPath(packages[name].files, relFile);
				pathObj[sCode] = cache.files[curFile][sCode];
			}

			stack.push(...cache.files[curFile][sDeps]);
		}
	}

	for (const file in staleFiles) {
		if (file.startsWith("/")) {
			//TODO: dirty deps
		} else {
			const packName = file.split("/")[0];
			packages[packName].dirty = true;
		}
	}

	cache = clonedCache;
	return {vfs, packages};
}

async function writeDeps(packageDir, vfs) {
	try {
		await fs.writeFile(packageDir + "/.deps.json", JSON.stringify(vfs));
	} catch (error) {
		console.error(error);
	}
}

async function writePackages(packageDir, packages) {
	const files = new Set(await fs.readdir(packageDir));
	files.delete(".deps.json");
	files.delete("preload.js");
	const jobs = [];

	for (const key of Object.keys(packages)) {
		const filename = `${key}.json`;
		const filepath = `${packageDir}/${filename}`;
		files.delete(filename);
		if (packages[key].dirty) {
			delete packages[key].dirty;
			jobs.push(fs.writeFile(filepath, JSON.stringify(packages[key])));
		}
	}

	for (const filename of files) {
		const filepath = `${packageDir}/${filename}`;
		jobs.push(fs.unlink(filepath));
	}

	try {
		await all(jobs);
	} catch (error) {
		console.error(error);
	}
}

//webroot is the relative path to the webroot folder
//entrypoints are paths to the entry points, relative to webroot
//outputDir is directory where preload_modules will be stored
async function build({webroot, entryPoints, outputDir}) {
	const absRoot = path.resolve(webroot);
	const absDir = path.resolve(outputDir);

	try {
		await all(entryPoints.map((entry) => buildCore(absRoot, entry)));
		const packageDir = absDir + "/preload_modules";

		const output = rebuildCacheAndVFS(absRoot, absDir, entryPoints);

		await writeDeps(packageDir, output.vfs);
		await writePackages(packageDir, output.packages);
	} catch (error) {
		console.error(error.stack);
	}
}

async function clean({outputDir}) {
	const absDir = path.resolve(outputDir);
	const packageDir = absDir + "/preload_modules";
	const files = new Set(await fs.readdir(packageDir));

	const jobs = [];
	for (const filename of files) {
		const filepath = `${packageDir}/${filename}`;
		jobs.push(fs.unlink(filepath));
	}

	await all(jobs);
}

async function init({outputDir}) {
	const absDir = path.resolve(outputDir);
	const packageDir = absDir + "/preload_modules";
	try {
		await fs.mkdir(packageDir);
	} catch (error) {
		//directory already exists; no problem here
	}
	const preloadWeb = require.resolve("./web/preload");
	const preloadScript = packageDir + "/preload.js";
	fs.createReadStream(preloadWeb).pipe(fs.createWriteStream(preloadScript));
}

async function loadConfig() {
	const configPath = path.resolve("preload.config.json");
	const config = JSON.parse(await fs.readFile(configPath));

	if (!config.webroot) {
		throw new Error("webroot missing from .preload-config");
	}
	if (!config.outputDir) {
		console.warn(
			"outputDir not specified in .preload-config",
			"defaulting to webroot"
		);
		config.output = config.webroot;
	}
	if (!config.entryPoints) {
		console.warn(
			"entryPoints not specified in .preload-config",
			"defaulting to [\"/index\"]"
		);
		config.entryPoints = ["/index"];
	}

	return config;
}

function flattenVfs(out, fullname, obj) {
	for (const key of Object.keys(obj)) {
		if (key[0] === "/") {
			out[fullname] = out[fullname] || {};
			out[fullname][key] = obj[key];
		} else {
			flattenVfs(out, `${fullname}/${key}`, obj[key], key);
		}
	}
}

async function reloadBundle(packName, packRoot, bundlePath, packageJson) {
	const bundleJob = fs.stat(bundlePath);
	const packageJob = fs.stat(packageJson);
	if ((await packageJob).mtimeMs < (await bundleJob).mtimeMs) {
		const pack = JSON.parse(await fs.readFile(bundlePath));
		const flattened = {};
		flattenVfs(flattened, packName, pack.files);
		//TODO: try to avoid having to rebuild the graph
		for (const key of Object.keys(flattened)) {
			const set = flattened[key][sDeps] = new JSONSet();
			const relFile = "/" + key.split("/").slice(1).join("/");
			const absFile = packRoot + relFile;
			const deps = parseDeps(flattened[key][sCode]);
			for (const dep of deps) {
				if (!isPackage(dep)) {
					//normal dependency
					const absDep = resolveFileRelative(packRoot, absFile, dep);
					const relDep = packName + absoluteToRelative(packRoot, absDep);
					set.add(relDep);
				} else {
					//node_module
					const name = dep.split("/")[0];
					let absDep;
					if (name in nodeLibs) {
						absDep = nodeLibs[name];
					} else {
						absDep = require.resolve(dep);
					}
					const absRoot = getPackageRoot(absDep);
					const relDep = absoluteToRelative(absRoot, absDep);
					set.add(name + relDep);
				}
			}
		}
		Object.assign(cache.files, flattened);
		cache.packages[packName] = {
			entry: pack.entry,
			dirty: false,
		};
	}
}

async function reloadBundles({outputDir}) {
	const packageDir = `${outputDir}/preload_modules`;
	const files = new Set(await fs.readdir(packageDir));
	files.delete(".deps.json");
	files.delete("preload.js");

	const jobs = [];
	for (const filename of files) {
		const packName = filename.split(".")[0];
		let packJson;
		let packRoot;
		if (packName in nodeLibs) {
			packRoot = getPackageRoot(nodeLibs[packName]);
			packJson = `${packRoot}/package.json`;
		} else {
			packJson = require.resolve(`${packName}/package.json`);
			packRoot = getPackageRoot(packJson);
		}
		const bundlePath = `${packageDir}/${filename}`;
		jobs.push(reloadBundle(packName, packRoot, bundlePath, packJson));
	}

	await all(jobs);
}

async function main(command) {
	const config = await loadConfig();
	if (command === "build") {
		await init(config);
		await reloadBundles(config);
		await build(config);
	} else if (command === "clean") {
		await clean(config);
	} else if (command === "rebuild") {
		await clean(config);
		await init(config);
		await build(config);
	} else if (command === "watch") {
		console.error("NOT IMPLEMENTED");
	} else {
		console.error("command not recognized");
	}
}

try {
	main(...process.argv.slice(2));
} catch (error) {
	console.error(error.trace);
}

//TODO: support smart rebuilding of deps as well as packages
//TODO: cache internal representation, don't use previous output
//TODO: handle case where outdated bundle doesn't get rebuilt if
//		all of its dependents are already up to date (and not rebuilt)
