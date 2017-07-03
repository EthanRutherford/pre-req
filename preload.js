#!/usr/bin/env node
/* eslint-disable no-console */

const detective = require("detective");
const {minify} = require("uglify-es");
const nodeLibs = require("node-libs-browser");
const path = require("path");
const fs = require("./async-fs");
const {all, each} = require("./async-util");

const preloadRegex = /\/\/#[ \t]+preload[ \t]+(\S*)/g;
const envRegex = /process.env.NODE_ENV/g;
let cache = {files: {}, packages: {}, dirty: false};

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
	return require.resolve(next).replace(/\\/g, "/");
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
		console.error(`ERROR: ${error.message}`);
		return "";
	}
}

function calcMap(browser, absRoot, metaPath, entry) {
	if (browser == null) return {};
	if (typeof browser === "string") {
		browser = {[entry]: browser};
	}

	const map = {};
	for (const name of Object.keys(browser)) {
		const absKey = resolveFileRelative(absRoot, metaPath, name);
		const absVal = resolveFileRelative(absRoot, metaPath, browser[name]);
		map[absKey] = absVal;
	}

	return map;
}

async function enterPackage(name, absRoot, relFile) {
	if (!(name in cache.packages)) {
		const metaPath = require.resolve(absRoot + "/package.json");
		const meta = JSON.parse(await fs.readFile(metaPath));
		const absMainEntry = require.resolve(absRoot);
		const mainEntry = absoluteToRelative(absRoot, absMainEntry);

		cache.packages[name] = {
			entry: mainEntry,
			files: [],
			browserMap: calcMap(meta.browser, absRoot, metaPath, mainEntry),
			dirty: false,
		};
	}

	await parsePackFile(name, absRoot, relFile);

	return name + relFile;
}

async function parsePackFile(packName, packRoot, relFile) {
	const pack = cache.packages[packName];
	const absFileTmp = `${packRoot}/${relFile.split("/").slice(1).join("/")}`;
	const absFile = pack.browserMap[absFileTmp] || absFileTmp;

	pack.dirty = true;
	pack.files.push(relFile);
	const obj = cache.files[relFile] = {};

	//json files don't have deps or get minified
	if (relFile.endsWith(".json")) {
		obj[sCode] = await getJSON(absFile);
		return;
	}

	const data = await getDependencies(absFile);
	const code = data.code.replace(envRegex, env);
	const minified = minify(code, minifyOptions);
	obj[sCode] = minified.code;
	obj[sDeps] = new JSONSet(data.deps);
}

async function parseFile(absRoot, relFile) {
	const absFile = absRoot + relFile;

	cache.dirty = true;
	const obj = cache.files[relFile] = {};
	const data = await getDependencies(absFile);
	obj[sDeps] = new JSONSet(data.deps);
}

function resolveFile(absRoot, prevFile, curFile) {
	if (isPackage(curFile)) {
		const name = curFile.split("/")[0];
		let absFile;
		if (name in nodeLibs) {
			if (!nodeLibs[name]) {
				throw new Error(`'${name}' does not have a browser implementation`);
			}
			absFile = nodeLibs[name];
		} else {
			absFile = require.resolve(curFile);
		}
		const packRoot = getPackageRoot(absFile);
		const relFile = `${name}${absoluteToRelative(packRoot, absFile)}`;
		return {isPackage: true, relFile, packRoot};
	}
	const absFile = resolveFileRelative(absRoot, prevFile, curFile);
	const relFile = absoluteToRelative(absRoot, absFile);
	return {isPackage: false, relFile, packRoot: null};
}

function resolveFiles(absRoot, prevFile, files) {
	prevFile = absRoot + prevFile;
	const results = [];
	for (const file of files) {
		try {
			results.push(resolveFile(absRoot, prevFile, file));
		} catch (error) {
			console.error(`ERROR: ${error.message}`);
		}
	}
	return results;
}

function resolvePackFiles(absRoot, packName, prevFile, files) {
	prevFile = `${absRoot}/${prevFile.split("/").slice(1).join("/")}`;
	const results = [];
	for (const file of files) {
		try {
			const result = resolveFile(absRoot, prevFile, file);
			if (!result.isPackage) {
				result.isPackage = true;
				result.relFile = packName + result.relFile;
				result.packRoot = absRoot;
			}
			results.push(result);
		} catch (error) {
			console.error(`ERROR: ${error.message}`);
		}
	}
	return results;
}

async function rebuildCacheAndVFS(absRoot, absDir, entries) {
	let outputDir = absoluteToRelative(absRoot, absDir);
	outputDir += outputDir.endsWith("/") ? "" : "/";

	const staleFiles = new Set(Object.keys(cache.files));

	const clonedCache = {files: {}, packages: {}, dirty: false};
	const packages = {};
	const vfs = {files: {}, packages: {}, outputDir};

	const stack = resolveFiles(absRoot, null, entries);
	while (stack.length > 0) {
		const {isPackage, relFile, packRoot} = stack.pop();
		if (relFile in clonedCache.files) {
			continue;
		}

		if (!(relFile in cache.files)) {
			if (!isPackage) {
				await parseFile(absRoot, relFile);
			} else {
				const packName = relFile.split("/")[0];
				await enterPackage(packName, packRoot, relFile);
			}
		}

		staleFiles.delete(relFile);
		clonedCache.files[relFile] = cache.files[relFile];

		let deps;

		if (!isPackage) {
			const pathObj = addPath(vfs.files, relFile);
			deps = resolveFiles(absRoot, relFile, cache.files[relFile][sDeps]);
			const minDeps = new JSONSet(deps.map((dep) => {
				const name = dep.relFile;
				return name[0] === "/" ? name : name.split("/")[0];
			}));
			pathObj[sDeps] = minDeps;
		} else {
			const parts = relFile.split("/");
			const name = parts.shift();
			const curFile = "/" + parts.join("/");
			deps = resolvePackFiles(packRoot, name, relFile, cache.files[relFile][sDeps]);
			const minDeps = new JSONSet(deps.map((dep) => {
				const name = dep.relFile;
				return name[0] === "/" ? name : name.split("/")[0];
			}));
			minDeps.delete(name);

			if (!(name in vfs.packages)) {
				vfs.packages[name] = {[sDeps]: new JSONSet()};
				clonedCache.packages[name] = {
					entry: cache.packages[name].entry,
					files: [],
					browserMap: cache.packages[name].browserMap,
					dirty: false,
				};
				packages[name] = {
					entry: cache.packages[name].entry,
					files: {},
					[sDeps]: vfs.packages[name][sDeps],
					dirty: cache.packages[name].dirty,
				};
			}

			clonedCache.packages[name].files.push(relFile);

			const sharedDepsSet = vfs.packages[name][sDeps];
			sharedDepsSet.addMany(minDeps);

			const pathObj = addPath(packages[name].files, curFile);
			pathObj[sCode] = cache.files[relFile][sCode];
		}

		stack.push(...deps);
	}

	vfs.dirty = cache.dirty;

	for (const file in staleFiles) {
		if (file[0] === "/") {
			vfs.dirty = true;
		} else {
			const packName = file.split("/")[0];
			packages[packName].dirty = true;
		}
	}

	cache = clonedCache;
	return {vfs, packages};
}

async function writeDeps(packageDir, vfs) {
	if (!vfs.dirty) {
		return;
	}
	delete vfs.dirty;

	try {
		await fs.writeFile(packageDir + "/.deps.json", JSON.stringify(vfs));
	} catch (error) {
		console.error(`ERROR: ${error.message}`);
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

	await each(jobs, null, (error) => {
		console.error(`ERROR: ${error.message}`);
	});
}

//webroot is the relative path to the webroot folder
//entrypoints are paths to the entry points, relative to webroot
//outputDir is directory where preload_modules will be stored
async function build({webroot, entryPoints, outputDir}) {
	const absRoot = path.resolve(webroot);
	const absDir = path.resolve(outputDir);

	try {
		const packageDir = absDir + "/preload_modules";
		const output = await rebuildCacheAndVFS(absRoot, absDir, entryPoints);

		const jobs = [
			writeDeps(packageDir, output.vfs),
			writePackages(packageDir, output.packages),
			saveCache(),
		];

		await each(jobs);
	} catch (error) {
		console.error(error.stack);
	}
}

async function clean({outputDir}) {
	const absDir = path.resolve(outputDir);
	const packageDir = absDir + "/preload_modules";
	const files = new Set(await fs.readdir(packageDir));

	const jobs = [];
	jobs.push(fs.unlink(path.resolve("./.cache")));
	for (const filename of files) {
		const filepath = `${packageDir}/${filename}`;
		jobs.push(fs.unlink(filepath));
	}

	await each(jobs, null, (error) => {
		console.error(`ERROR: ${error.message}`);
	});
}

async function init({outputDir}) {
	const absDir = path.resolve(outputDir);
	const packageDir = absDir + "/preload_modules";
	try {
		await fs.mkdir(packageDir);
	} catch (error) {
		if (error.code === "EEXIST") {
			//directory already exists; no problem here
		} else {
			throw error;
		}
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

async function saveCache() {
	const string = JSON.stringify(cache);
	await fs.writeFile(__dirname + "/.cache", string);
}

function removeFile(file) {
	delete cache.files[file];
	cache.dirty = true;
}

function removePackage(packName) {
	for (const file of cache.packages[packName].files) {
		delete cache.files[file];
	}
	delete cache.packages[packName];
}

function getPackageMeta(packName) {
	if (packName in nodeLibs) {
		const packRoot = getPackageRoot(nodeLibs[packName]);
		return `${packRoot}/package.json`;
	}
	return require.resolve(`${packName}/package.json`);
}

async function restoreCache({webroot}) {
	const absRoot = path.resolve(webroot);

	const cachepath = __dirname + "/.cache";
	try {
		const jobs = [fs.stat(cachepath), fs.readFile(cachepath)];
		const [stats, string] = await all(jobs);

		const reviver = (k, v) => k === sDeps ? new JSONSet(v) : v;
		cache = JSON.parse(string, reviver);
		const lastRun = stats.mtimeMs;

		const packages = Object.keys(cache.packages);
		for (const packName of packages) {
			try {
				const metaFile = getPackageMeta(packName);
				const mtime = (await fs.stat(metaFile)).mtimeMs;
				if (mtime > lastRun) {
					removePackage(packName);
				}
			} catch (error) {
				removePackage(packName);
			}
		}

		const files = Object.keys(cache.files);
		for (const file of files) {
			if (file[0] !== "/") continue;
			try {
				const mtime = (await fs.stat(absRoot + file)).mtimeMs;
				if (mtime > lastRun) {
					removeFile(file);
				}
			} catch (error) {
				removeFile(file);
			}
		}
	} catch (error) {
		if (error.code === "ENOENT") {
			//do nothing, this build will simply be from scratch
		} else {
			throw error;
		}
	}
}

async function main(command) {
	try {
		console.log(`running ${command}...`);
		const start = Date.now();
		const config = await loadConfig();
		if (command === "build") {
			await init(config);
			await restoreCache(config);
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
		const elapsed = Date.now() - start;
		console.log(`${command} finished in ${elapsed}ms`);
	} catch (error) {
		console.error(error.stack);
	}
}

main(...process.argv.slice(2));
