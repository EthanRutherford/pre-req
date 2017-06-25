#!/usr/bin/env node

const detective = require("detective");
const {minify} = require("uglify-es");
const nodeLibs = require("node-libs-browser");
const path = require("path");
const fs = require("fs");

const preloadRegex = /\/\/#[ \t]+preload[ \t]+(\S*)/g;
const envRegex = /process.env.NODE_ENV/g;
const cache = {files: {}, packages: {}, outputDir: "/"};
const packages = {};

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
	if (!(name in cache.packages)) {
		const absMainEntry = require.resolve(absRoot);
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

//webroot is the relative path to the webroot folder
//entrypoints are paths to the entry points, relative to webroot
//outputDir is directory where preload_modules will be stored
function build({webroot, entryPoints, outputDir}) {
	const absRoot = path.resolve(webroot);
	const absDir = path.resolve(outputDir);
	cache.outputDir = absoluteToRelative(absRoot, absDir);
	cache.outputDir += cache.outputDir.endsWith("/") ? "" : "/";

	const promises = entryPoints.map((entry) => buildCore(absRoot, entry));

	Promise.all(promises).then(() => {
		const packageDir = absDir + "/preload_modules";

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

//outputDir is directory where preload_modules will be stored
function init({outputDir}) {
	const absDir = path.resolve(outputDir);
	const packageDir = absDir + "/preload_modules";
	if (!fs.existsSync(packageDir)) {
		fs.mkdirSync(packageDir);
	}
	const preloadWeb = require.resolve("./web/preload");
	const preloadScript = packageDir + "/preload.js";
	fs.createReadStream(preloadWeb).pipe(fs.createWriteStream(preloadScript));
}

function loadConfig() {
	const configPath = path.resolve("preload.config.json");
	if (!fs.existsSync(configPath)) {
		throw new Error("no config file (preload.config.json)");
	}
	const config = JSON.parse(fs.readFileSync(configPath));

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

function main(command) {
	const config = loadConfig();
	if (command === "build") {
		init(config);
		build(config);
	} else if (command === "watch") {
		console.error("NOT IMPLEMENTED");
	} else {
		console.error("command not recognized");
	}
}

main(...process.argv.slice(2));

// fs.watch(filename[, options][, listener])
