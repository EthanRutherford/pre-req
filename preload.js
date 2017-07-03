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
		console.error(`ERROR: ${error.message}`);
		return "";
	}
}

async function parsePackage(packName, absRoot, prevFile, curFile) {
	const pack = cache.packages[packName];
	const absFileTmp = resolveFileRelative(absRoot, prevFile, curFile);
	const relFile = packName + absoluteToRelative(absRoot, absFileTmp);
	const absFile = pack.browserMap[absFileTmp] || absFileTmp;
	if (relFile in cache.files) {
		return relFile;
	}

	pack.dirty = true;
	pack.files.push(relFile);
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

	await each(jobs, (result) => {
		obj[sDeps].add(result);
	}, (error) => {
		console.error(`ERROR: ${error.message}`);
	});

	return relFile;
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

	await parsePackage(name, absRoot, null, relFile);

	return name + relFile;
}

async function parseTree(absRoot, prevFile, curFile) {
	const absFile = resolveFileRelative(absRoot, prevFile, curFile);
	const relFile = absoluteToRelative(absRoot, absFile);
	if (relFile in cache.files || !relFile.endsWith(".js")) {
		return relFile;
	}

	cache.dirty = true;
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

	await each(jobs, (result) => {
		obj[sDeps].add(result);
	}, (error) => {
		console.error(`ERROR: ${error.message}`);
	});

	return relFile;
}

async function rebuildCacheAndVFS(absRoot, absDir, entries) {
	let outputDir = absoluteToRelative(absRoot, absDir);
	outputDir += outputDir.endsWith("/") ? "" : "/";

	const staleFiles = new Set(Object.keys(cache.files));

	const clonedCache = {files: {}, packages: {}, dirty: false};
	const packages = {};
	const vfs = {files: {}, packages: {}, outputDir};

	for (const entry of entries) {
		const absFile = resolveFileRelative(absRoot, null, entry);
		const relFile = absoluteToRelative(absRoot, absFile);

		const stack = [relFile];
		while (stack.length > 0) {
			const curFile = stack.pop();
			const isPackage = curFile[0] !== "/";
			if (curFile in clonedCache.files) {
				continue;
			}

			if (!(curFile in cache.files)) {
				if (!isPackage) {
					await parseTree(absRoot, null, curFile);
				} else {
					const packName = curFile.split("/")[0];
					await buildPackage(packName, curFile);
				}
			}

			staleFiles.delete(curFile);

			clonedCache.files[curFile] = cache.files[curFile];
			const minDeps = cache.files[curFile][sDeps].map((name) => {
				return name[0] === "/" ? name : name.split("/")[0];
			});

			if (!isPackage) {
				const pathObj = addPath(vfs.files, curFile);
				pathObj[sDeps] = minDeps;
			} else {
				const parts = curFile.split("/");
				const name = parts.shift();
				const relFile = "/" + parts.join("/");
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

				clonedCache.packages[name].files.push(curFile);

				const sharedDepsSet = vfs.packages[name][sDeps];
				sharedDepsSet.addMany(minDeps);

				const pathObj = addPath(packages[name].files, relFile);
				pathObj[sCode] = cache.files[curFile][sCode];
			}

			stack.push(...cache.files[curFile][sDeps]);
		}
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
	await fs.writeFile(path.resolve("./.cache"), string);
}

function removeFile(file) {
	delete cache.files[file];
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

	const cachepath = path.resolve("./.cache");
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
		const start = Date.now();
		console.log(`running ${command}...`);
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
		console.log(`${command} finished in ${Date.now() - start}ms`);
	} catch (error) {
		console.error(error.stack);
	}
}

main(...process.argv.slice(2));

//TODO: re-evaluate/refactor the parse(Tree/Package) flow
