#!/usr/bin/env node
/* eslint-disable no-console */

const detective = require("detective");
const {minify} = require("uglify-es");
const nodeLibs = require("node-libs-browser");
const path = require("path");
const fs = require("./lib/async-fs");
const {all, each} = require("./lib/async-util");
const fillTemplate = require("./lib/html");

const preloadRegex = /\/\/#[ \t]+preload[ \t]+(\S*)/g;
const envRegex = /process.env.NODE_ENV/g;
let cache = {files: {}, templates: {}, packages: {}, dirty: false};

const sDeps = "/deps";
const sCode = "/code";

/**
 * @typedef VFS
 * @property {any} files
 * @property {any} packages
 * @property {string} outputDir
 * @property {boolean=} dirty
*/
/**
 * @typedef HTMLTemplate
 * @property {string} main
 * @property {string} html
 * @property {string} template
 * @property {boolean=} dirty
*/
/**
 * @typedef Config
 * @property {string=} webroot
 * @property {string=} outputDir
 * @property {string[]=} entryPoints
 * @property {HTMLTemplate[]=} html
*/

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

/**
 * add path to vfs
 * @param {any} data
 * @param {string} pathName
 * @returns {any}
 */
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

/**
 * resolve a path relative to another path
 * @param {string} root
 * @param {string} file
 * @param {string} next
 * @returns {string}
 */
function resolveFileRelative(root, file, next) {
	if (next[0] === "/") {
		next = root + next;
	} else {
		const dir = path.dirname(file);
		next = path.resolve(dir, next);
	}
	return require.resolve(next).replace(/\\/g, "/");
}

/**
 * get the path to a package from a filepath
 * @param {string} absFile
 * @returns {string}
 */
function getPackageRoot(absFile) {
	const parts = absFile.replace(/\\/g, "/").split("/");
	return parts.slice(0, parts.findIndex((x) => x === "node_modules") + 2).join("/");
}

/**
 * checks if the given path is a package
 * @param {string} name
 * @returns {boolean}
 */
function isPackage(name) {
	return !(name[0] === "/" || name.startsWith("./") || name.startsWith("../"));
}

/**
 * get relative filepath given the absolute root and path
 * @param {string} root
 * @param {string} file
 * @returns {string}
 */
function absoluteToRelative(root, file) {
	const rel = path.relative(root, file).replace(/\\/g, "/");
	if (rel.startsWith("..")) throw new Error("path outside webroot");
	return "/" + rel;
}

/**
 * find all dependencies
 * @param {string} code
 * @returns {string[]}
 */
function parseDeps(code) {
	const deps = new Set(detective(code));
	let match;
	while ((match = preloadRegex.exec(code))) {
		const [, dep] = match;
		deps.add(dep.trim());
	}
	return [...deps];
}

/**
 * get dependencies from file
 * @param {string} src
 * @returns {Promise<{code: string, deps: string[]}>}
 */
async function getDependencies(src) {
	try {
		const code = (await fs.readFile(src)).toString();
		return {code, deps: parseDeps(code)};
	} catch (error) {
		console.error(`ERROR: ${error.message}`);
		return {code: "", deps: []};
	}
}

/**
 * get content of json file
 * @param {string} file
 * @returns {Promise<string>}
 */
async function getJSON(file) {
	try {
		return JSON.stringify(JSON.parse((await fs.readFile(file)).toString()));
	} catch (error) {
		console.error(`ERROR: ${error.message}`);
		return "";
	}
}

/**
 * get the content of a template
 * @param {string} templatePath
 * @returns {Promise<{content: string, dirty: boolean}>}
 */
async function getTemplate(templatePath) {
	if (cache.templates[templatePath] != null) {
		return {
			content: cache.templates[templatePath],
			dirty: false,
		};
	}

	return {
		content: (await fs.readFile(templatePath)).toString(),
		dirty: true,
	};
}

/**
 * get the mapping of browser proxy paths
 * @param {any} browser
 * @param {string} absRoot
 * @param {string} metaPath
 * @param {string} entry
 * @returns {{[x: string]: string}}
 */
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

/**
 * ensure package is loaded into cache
 * @param {string} name
 * @param {string} absRoot
 * @param {string} relFile
 * @returns {Promise<string>}
 */
async function enterPackage(name, absRoot, relFile) {
	if (!(name in cache.packages)) {
		const metaPath = require.resolve(absRoot + "/package.json");
		const meta = JSON.parse((await fs.readFile(metaPath)).toString());
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

/**
 * parse individual file from package
 * @param {string} packName
 * @param {string} packRoot
 * @param {string} relFile
 * @returns {Promise<void>}
 */
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

/**
 * parse individual file
 * @param {string} absRoot
 * @param {string} relFile
 * @returns {Promise<void>}
 */
async function parseFile(absRoot, relFile) {
	const absFile = absRoot + relFile;

	cache.dirty = true;
	const obj = cache.files[relFile] = {};
	const data = await getDependencies(absFile);
	obj[sDeps] = new JSONSet(data.deps);
}

/**
 * resolve a relative path to a file location
 * @param {string} absRoot
 * @param {string} prevFile
 * @param {string} curFile
 * @returns {{isPackage: boolean, relFile: string, packRoot: string}}
 */
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

/**
 * resolves multiple files
 * @param {string} absRoot
 * @param {string} prevFile
 * @param {string[]} files
 * @returns {{isPackage: boolean, relFile: string, packRoot: string}[]}
 */
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

/**
 * resolves files in a package
 * @param {string} absRoot
 * @param {string} packName
 * @param {string} prevFile
 * @param {string[]} files
 * @returns {{isPackage: boolean, relFile: string, packRoot: string}[]}
 */
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

/**
 * rebuilds the cache, filling in any holes caused by changed files
 * @param {string} absRoot
 * @param {string} absDir
 * @param {string[]} entries
 * @param {HTMLTemplate[]} html
 * @returns {Promise<{vfs: VFS, packages}>}
 */
async function rebuildCacheAndVFS(absRoot, absDir, entries, html) {
	let outputDir = absoluteToRelative(absRoot, absDir);
	outputDir += outputDir.endsWith("/") ? "" : "/";

	const staleFiles = new Set(Object.keys(cache.files));

	const clonedCache = {
		files: {},
		templates: {},
		packages: {},
		dirty: false,
	};
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

	for (const page of html) {
		const templatePath = path.resolve(page.template);
		const template = await getTemplate(templatePath);
		clonedCache.templates[templatePath] = template.content;
		page.dirty = template.dirty;
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

/**
 * builds html from a template
 * @param {string} absRoot
 * @param {string} preloadPath
 * @param {HTMLTemplate} page
 * @param {string} deps
 * @param {boolean} wasDirty
 * @returns {Promise<void>}
 */
async function buildTemplate(absRoot, preloadPath, page, deps, wasDirty) {
	const filePath = path.resolve(absRoot + "/" + page.html);
	const absMain = resolveFileRelative(absRoot, null, page.main);
	const mainPath = absoluteToRelative(absRoot, absMain);
	const template = cache.templates[path.resolve(page.template)];

	if (page.dirty || wasDirty) {
		const content = fillTemplate(template, preloadPath, deps, mainPath);
		await fs.writeFile(filePath, content);
		delete page.dirty;
	}
}

/**
 * writes output files
 * @param {string} absRoot
 * @param {string} packageDir
 * @param {VFS} vfs
 * @param {HTMLTemplate[]} html
 * @returns {Promise<void>}
 */
async function writeDepsAndHtml(absRoot, packageDir, vfs, html) {
	const wasDirty = vfs.dirty;
	delete vfs.dirty;

	const deps = JSON.stringify(vfs);
	const preloadPath = absoluteToRelative(absRoot, packageDir) + "/preload.js";

	const jobs = [];

	if (wasDirty) {
		jobs.push(fs.writeFile(packageDir + "/.deps.json", deps));
	}

	for (const page of html) {
		jobs.push(buildTemplate(absRoot, preloadPath, page, deps, wasDirty));
	}

	await each(jobs, null, (error) => {
		console.error(`ERROR: ${error.message}`);
	});
}

/**
 * writes output packages
 * @param {string} packageDir
 * @param {any} packages
 * @returns {Promise<void>}
 */
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

/**
 * webroot is the relative path to the webroot folder
 *
 * entrypoints are paths to the entry points, relative to webroot
 *
 * outputDir is directory where preload_modules will be stored
 * @returns {Promise<void>}
 */
async function build(/** @type {Config} */ {webroot, entryPoints, outputDir, html}) {
	const absRoot = path.resolve(webroot);
	const absDir = path.resolve(outputDir);

	try {
		const packageDir = absDir + "/preload_modules";
		const output = await rebuildCacheAndVFS(absRoot, absDir, entryPoints, html);

		const jobs = [
			writeDepsAndHtml(absRoot, packageDir, output.vfs, html),
			writePackages(packageDir, output.packages),
			saveCache(),
		];

		await each(jobs);
	} catch (error) {
		console.error(error.stack);
	}
}

/**
 * clean the outputDir
 * @returns {Promise<void>}
 */
async function clean(/** @type {Config} */ {outputDir}) {
	const absDir = path.resolve(outputDir);
	const packageDir = absDir + "/preload_modules";
	const files = new Set(await fs.readdir(packageDir));
	const cachepath = __dirname + "/.cache";

	const jobs = [];
	jobs.push(fs.unlink(cachepath));
	for (const filename of files) {
		const filepath = `${packageDir}/${filename}`;
		jobs.push(fs.unlink(filepath));
	}

	await each(jobs, null, (error) => {
		console.error(`ERROR: ${error.message}`);
	});
}

/**
 * make sure the outputDir exists and has preload.js installed
 * @returns {Promise<void>}
 */
async function init(/** @type {Config} */ {outputDir}) {
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

/**
 * load the config
 * @returns {Promise<Config>}
 */
async function loadConfig() {
	const configPath = path.resolve("preload.config.json");
	const config = JSON.parse((await fs.readFile(configPath)).toString());

	if (!config.webroot) {
		throw new Error("webroot missing from .preload-config");
	}
	if (!config.outputDir) {
		console.warn(
			"outputDir not specified in .preload-config",
			"defaulting to webroot"
		);
		config.outputDir = config.webroot;
	}
	if (!config.entryPoints) {
		console.warn(
			"entryPoints not specified in .preload-config",
			"defaulting to [\"/index\"]"
		);
		config.entryPoints = ["/index"];
	}
	if (!config.html) {
		config.html = [];
	}

	for (const html of config.html) {
		if (!html.main) {
			throw new Error("bad html config: missing main");
		} else if (!html.html) {
			throw new Error("bad html config: missing html");
		} else if (!html.template) {
			throw new Error("bad html config: missing template");
		}
	}

	return config;
}

/**
 * saves the cache for next time
 * @returns {Promise<void>}
 */
async function saveCache() {
	const string = JSON.stringify(cache);
	await fs.writeFile(__dirname + "/.cache", string);
}

/**
 * remove the file from the cache
 * @param {string} file
 * @returns {void}
 */
function removeFile(file) {
	delete cache.files[file];
	cache.dirty = true;
}

/**
 * remove the template from the cache
 * @param {string} template
 * @returns {void}
 */
function removeTemplate(template) {
	delete cache.templates[template];
}

/**
 * remove the package from the cache
 * @param {string} packName
 * @returns {void}
 */
function removePackage(packName) {
	for (const file of cache.packages[packName].files) {
		delete cache.files[file];
	}
	delete cache.packages[packName];
}

/**
 * resolve the location of the package's package.json file
 * @param {string} packName
 * @returns {string}
 */
function getPackageMeta(packName) {
	if (packName in nodeLibs) {
		const packRoot = getPackageRoot(nodeLibs[packName]);
		return `${packRoot}/package.json`;
	}
	return require.resolve(`${packName}/package.json`);
}

/**
 * restores the cache from last time
 * @returns {Promise<void>}
 */
async function restoreCache(/** @type {Config} */ {webroot}) {
	const absRoot = path.resolve(webroot);

	const cachepath = __dirname + "/.cache";
	try {
		const jobs = [fs.stat(cachepath), fs.readFile(cachepath)];
		const [stats, string] = await all(jobs);

		const reviver = (k, v) => k === sDeps ? new JSONSet(v) : v;
		const prevCache = JSON.parse(string, reviver);
		cache = {
			files: prevCache.files || {},
			templates: prevCache.templates || {},
			packages: prevCache.packages || {},
			dirty: prevCache.dirty || false,
		};
		const lastRun = stats.mtimeMs;

		const packages = Object.keys(cache.packages);
		for (const packName of packages) {
			try {
				const metaFile = getPackageMeta(packName);
				// @ts-ignore Stat interface is missing member
				const mtime = (await fs.stat(metaFile)).mtimeMs;
				if (mtime > lastRun) {
					removePackage(packName);
				}
			} catch (error) {
				removePackage(packName);
			}
		}

		const templates = Object.keys(cache.templates);
		for (const template of templates) {
			try {
				// @ts-ignore Stat interface is missing member
				const mtime = (await fs.stat(path.resolve(template))).mtimeMs;
				if (mtime > lastRun) {
					removeTemplate(template);
				}
			} catch (error) {
				removeTemplate(template);
			}
		}

		const files = Object.keys(cache.files);
		for (const file of files) {
			if (file[0] !== "/") continue;
			try {
				// @ts-ignore Stat interface is missing member
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

/**
 * main entry point to the program
 * @param {string=} command
 */
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
