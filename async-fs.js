const fs = require("fs");

function mkdir(path) {
	return new Promise((resolve, reject) => {
		fs.mkdir(path, (error) => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		});
	});
}

function readFile(filename) {
	return new Promise((resolve, reject) => {
		fs.readFile(filename, (error, data) => {
			if (error) {
				reject(error);
			} else {
				resolve(data);
			}
		});
	});
}

function writeFile(filename, data) {
	return new Promise((resolve, reject) => {
		fs.writeFile(filename, data, (error) => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		});
	});
}

module.exports = Object.assign({}, fs, {
	mkdir,
	readFile,
	writeFile,
});
