#!/usr/bin/env node
/* eslint-disable no-console */

const detective = require("detective");
const {minify} = require("uglify-es");
const nodeLibs = require("node-libs-browser");
const path = require("path");
const fs = require("./async-fs");

const preloadRegex = /\/\/#[ \t]+preload[ \t]+(\S*)/g;
const envRegex = /process.env.NODE_ENV/g;
let cache = {};
let packages = {};

const sDeps = "/deps";
const sCode = "/code";

const env = process.env.NODE_ENV; //eslint-disable-line no-process-env
const minifyOptions = {
	compress: {
		dead_code: true, //eslint-disable-line camelcase
	},
};

class JSONSet extends Set {
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

function hasPath(data, pathName) {
	pathName = pathName.substr(1);
	if (pathName === "") return true;
	const parts = pathName.split("/");
	for (const part of parts) {
		if (!(part in data)) {
			return false;
		}
		data = data[part];
	}
	return true;
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

async function getDependencies(src) {
	try {
		const data = (await fs.readFile(src)).toString();
		const deps = new Set(detective(data));
		let match;
		while ((match = preloadRegex.exec(data))) {
			const [, dep] = match;
			deps.add(dep.trim());
		}
		return {code: data, deps: [...deps]};
	} catch (error) {
		console.error("file read error", error);
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

async function parsePackage(pack, absRoot, absFile, relFile) {
	if (hasPath(pack.files, relFile)) {
		return;
	}
	const pathObj = addPath(pack.files, relFile);

	//don't parse deps or minify json files
	if (relFile.endsWith(".json")) {
		pathObj[sCode] = await getJSON(absFile);
		return;
	}

	const data = await getDependencies(absFile);
	const code = data.code.replace(envRegex, env);
	const minified = minify(code, minifyOptions);
	pathObj[sCode] = minified.code;

	const jobs = [];
	for (const dep of data.deps) {
		if (!isPackage(dep)) {
			//normal dependency
			const absDep = resolveFileRelative(absRoot, absFile, dep);
			const relDep = absoluteToRelative(absRoot, absDep);
			jobs.push(parsePackage(pack, absRoot, absDep, relDep));
		} else {
			//node_module
			try {
				const packageName = dep.split("/")[0];
				pack[sDeps].add(packageName);
				jobs.push(buildPackage(packageName, dep));
			} catch (error) {
				console.error(`ERROR: ${error.message}`);
			}
		}
	}

	await Promise.all(jobs);
}

function buildPackage(name, entry) {
	let absFile;
	if (name in nodeLibs) {
		if (!nodeLibs[name]) {
			throw new Error(`${name} does not have a browser implementation`);
		}
		absFile = nodeLibs[name];
	} else {
		absFile = require.resolve(entry);
	}
	const absRoot = getPackageRoot(absFile);
	const relFile = absoluteToRelative(absRoot, absFile);
	if (!(name in packages)) {
		const absMainEntry = require.resolve(absRoot);
		const mainEntry = absoluteToRelative(absRoot, absMainEntry);

		packages[name] = {
			entry: mainEntry,
			files: {},
			[sDeps]: new JSONSet(),
		};
	}

	return parsePackage(packages[name], absRoot, absFile, relFile);
}

async function parseTree(absRoot, absFile, relFile) {
	if (relFile in cache || !relFile.endsWith(".js")) {
		return;
	}
	const obj = cache[relFile] = {};

	const data = await getDependencies(absFile);
	obj[sDeps] = new JSONSet();

	const jobs = [];
	for (const dep of data.deps) {
		if (!isPackage(dep)) {
			//normal dependency
			try {
				const absDep = resolveFileRelative(absRoot, absFile, dep);
				const relDep = absoluteToRelative(absRoot, absDep);
				obj[sDeps].add(relDep);
				jobs.push(parseTree(absRoot, absDep, relDep));
			} catch (error) {
				console.error(`ERROR: ${error.message}`);
			}
		} else {
			//node_module
			const packageName = dep.split("/")[0];
			try {
				jobs.push(buildPackage(packageName, dep));
				obj[sDeps].add(packageName);
			} catch (error) {
				console.error(`ERROR: ${error.message}`);
			}
		}
	}

	await Promise.all(jobs);
}

async function buildCore(absRoot, entry) {
	const absFile = resolveFileRelative(absRoot, null, entry);
	const relFile = absoluteToRelative(absRoot, absFile);

	await parseTree(absRoot, absFile, relFile);
}

function rebuildCacheAndVFS(absRoot, absDir, entries) {
	let outputDir = absoluteToRelative(absRoot, absDir);
	outputDir += outputDir.endsWith("/") ? "" : "/";

	const clonedCache = {};
	const clonedPackages = {};
	const vfs = {files: {}, packages: {}, outputDir};

	for (const entry of entries) {
		const absFile = resolveFileRelative(absRoot, null, entry);
		const relFile = absoluteToRelative(absRoot, absFile);

		const stack = [relFile];
		while (stack.length > 0) {
			const curFile = stack.pop();
			let deps;

			if (curFile.startsWith("/")) {
				if (curFile in clonedCache) {
					continue;
				}
				clonedCache[curFile] = cache[curFile];
				Object.assign(addPath(vfs.files, curFile), cache[curFile]);

				deps = cache[curFile][sDeps];
			} else {
				if (curFile in clonedPackages) {
					continue;
				}
				clonedPackages[curFile] = packages[curFile];
				vfs.packages[curFile] = {[sDeps]: packages[curFile][sDeps]};

				deps = packages[curFile][sDeps];
			}

			stack.push(...deps);
		}
	}

	cache = clonedCache;
	packages = clonedPackages;
	return vfs;
}

async function writeDeps(packageDir, vfs) {
	try {
		await fs.writeFile(packageDir + "/.deps.json", JSON.stringify(vfs));
	} catch (error) {
		console.error(error);
	}
}

async function writePackages(packageDir) {
	for (const key of Object.keys(packages)) {
		const filename = `${packageDir}/${key}.json`;
		try {
			await fs.writeFile(filename, JSON.stringify(packages[key]));
		} catch (error) {
			console.error(error);
		}
	}
}

//webroot is the relative path to the webroot folder
//entrypoints are paths to the entry points, relative to webroot
//outputDir is directory where preload_modules will be stored
async function build({webroot, entryPoints, outputDir}) {
	const absRoot = path.resolve(webroot);
	const absDir = path.resolve(outputDir);

	try {
		await Promise.all(entryPoints.map((entry) => buildCore(absRoot, entry)));
		const packageDir = absDir + "/preload_modules";

		const vfs = rebuildCacheAndVFS(absRoot, absDir, entryPoints);

		await writeDeps(packageDir, vfs);
		await writePackages(packageDir);
	} catch (error) {
		console.error(error.stack);
	}
}

//outputDir is directory where preload_modules will be stored
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

async function main(command) {
	const config = await loadConfig();
	if (command === "build") {
		init(config);
		build(config);
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
