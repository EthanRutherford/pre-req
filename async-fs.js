const fs = require("fs");
const util = require("util");

module.exports = {
	createReadStream: fs.createReadStream,
	createWriteStream: fs.createWriteStream,
	mkdir: util.promisify(fs.mkdir),
	readdir: util.promisify(fs.readdir),
	readFile: util.promisify(fs.readFile),
	unlink: util.promisify(fs.unlink),
	writeFile: util.promisify(fs.writeFile),
};
