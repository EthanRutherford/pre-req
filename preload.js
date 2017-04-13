#!/usr/bin/env node

const detective = require("detective");
const {minify} = require("uglify-js-harmony");
const path = require("path");
const fs = require("fs");

const preloadRegex = /\/\/#[ \t]+preload[ \t]+(\S*)/g;
const envRegex = /process.env.NODE_ENV/g;
const cache = {files: {}, packages: {}};
const packages = {};

const sDeps = "/deps";
const sCode = "/code";

const env = process.env.NODE_ENV; //eslint-disable-line no-process-env
const minifyOptions = {
	dead_code: true, //eslint-disable-line camelcase
	fromString: true,
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
	if (pathName === "") return data;
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
		return require.resolve(root + next);
	}
	const dir = path.dirname(file);
	return require.resolve(path.resolve(dir, next));
}

function getPackageRoot(packageName, absFile) {
	let absRoot = absFile;
	while (!absRoot.endsWith(packageName)) {
		absRoot = path.dirname(absRoot);
	}
	return absRoot;
}

function isPackage(name) {
	return !(name[0] === "/" || name.startsWith("./") || name.startsWith("../"));
}

function absoluteToRelative(root, file) {
	const rel = path.relative(root, file).replace(/\\/g, "/");
	if (rel.startsWith("..")) throw new Error("path outside webroot");
	return "/" + rel;
}

function getDependencies(src) {
	return new Promise((resolve) => {
		fs.readFile(src, (error, data) => {
			if (error) {
				console.error("file read error", error);
				resolve({});
			} else {
				data = data.toString();
				const deps = new Set(detective(data));
				let match;
				while ((match = preloadRegex.exec(data))) {
					const [, dep] = match;
					deps.add(dep.trim());
				}
				resolve({code: data, deps: [...deps]});
			}
		});
	});
}

function getJSON(file) {
	return new Promise((resolve) => {
		fs.readFile(file, (error, data) => {
			if (error) {
				console.error("file read error", error);
				resolve("");
			} else {
				resolve(JSON.stringify(JSON.parse(data)));
			}
		});
	});
}

function parsePackage(pack, absRoot, absFile, relFile) {
	if (hasPath(pack.files, relFile)) {
		return Promise.resolve();
	}
	const pathObj = addPath(pack.files, relFile);

	//don't parse deps or minify json files
	if (relFile.endsWith(".json")) {
		return getJSON(absFile).then((json) => {
			pathObj[sCode] = json;
		});
	}

	return new Promise((resolve) => {
		getDependencies(absFile).then((data) => {
			const code = data.code.replace(envRegex, env);
			const minified = minify(code, minifyOptions);
			pathObj[sCode] = minified.code;

			const promises = [];
			for (const dep of data.deps) {
				if (!isPackage(dep)) {
					//normal dependency
					const absDep = resolveFileRelative(absRoot, absFile, dep);
					const relDep = absoluteToRelative(absRoot, absDep);
					promises.push(parsePackage(pack, absRoot, absDep, relDep));
				} else {
					//node_module
					const packageName = dep.split("/")[0];
					pack[sDeps].add(packageName);
					promises.push(buildPackage(packageName, dep));
				}
			}

			Promise.all(promises).then(resolve);
		});
	});
}

function buildPackage(name, entry) {
	const absFile = require.resolve(entry);
	const absRoot = getPackageRoot(name, absFile);
	const relFile = absoluteToRelative(absRoot, absFile);
	if (!(name in cache.packages)) {
		const absMainEntry = require.resolve(name);
		const mainEntry = absoluteToRelative(absRoot, absMainEntry);

		cache.packages[name] = {name, "/deps": new JSONSet()};
		packages[name] = {
			name,
			files: {},
			"/deps": cache.packages[name][sDeps],
			entry: mainEntry,
		};
	}

	return parsePackage(packages[name], absRoot, absFile, relFile);
}

function parseTree(absRoot, absFile, relFile) {
	if (hasPath(cache.files, relFile) || !relFile.endsWith(".js")) {
		return Promise.resolve();
	}
	const pathObj = addPath(cache.files, relFile);

	return new Promise((resolve) => {
		getDependencies(absFile).then((data) => {
			pathObj[sDeps] = new JSONSet();

			const promises = [];
			for (const dep of data.deps) {
				if (!isPackage(dep)) {
					//normal dependency
					const absDep = resolveFileRelative(absRoot, absFile, dep);
					const relDep = absoluteToRelative(absRoot, absDep);
					pathObj[sDeps].add(relDep);
					promises.push(parseTree(absRoot, absDep, relDep));
				} else {
					//node_module
					const packageName = dep.split("/")[0];
					pathObj[sDeps].add(packageName);
					promises.push(buildPackage(packageName, dep));
				}
			}

			Promise.all(promises).then(resolve);
		});
	});
}

function buildCore(absRoot, entry) {
	const absFile = resolveFileRelative(absRoot, null, entry);
	const relFile = absoluteToRelative(absRoot, absFile);

	return parseTree(absRoot, absFile, relFile);
}

//root is the relative path to the webroot folder
//entry is the path to the entry point, relative to the root folder
function build(root, ...entries) {
	const absRoot = path.resolve(root);

	const promises = entries.map((entry) => buildCore(absRoot, entry));

	Promise.all(promises).then(() => {
		const packageDir = absRoot + "/preload_modules";
		if (!fs.existsSync(packageDir)) {
			fs.mkdirSync(packageDir);
		}

		fs.writeFile(packageDir + "/.deps.json", JSON.stringify(cache), (error) => {
			if (error) {
				console.error(error);
			}
		});

		for (const key of Object.keys(packages)) {
			const filename = `${packageDir}/${key}.json`;
			fs.writeFile(filename, JSON.stringify(packages[key]), (error) => {
				if (error) {
					console.error(error);
				}
			});
		}
	});
}

//root is the relative path to the webroot folder (where preload web will be copied to)
function init(root) {
	const absRoot = path.resolve(root);
	const packageDir = absRoot + "/preload_modules";
	if (!fs.existsSync(packageDir)) {
		fs.mkdirSync(packageDir);
	}
	const preloadWeb = require.resolve("./web/preload");
	const preloadScript = packageDir + "/preload.js";
	fs.createReadStream(preloadWeb).pipe(fs.createWriteStream(preloadScript));
}

function main(command, ...options) {
	if (command === "build") {
		build(...options);
	} else if (command === "init") {
		init(...options);
	} else if (command === "watch") {
		console.error("NOT IMPLEMENTED");
	} else {
		console.error("command not recognized");
	}
}

main(...process.argv.slice(2));

// fs.watch(filename[, options][, listener])
