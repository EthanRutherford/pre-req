/** @type {function(Promise[]): Promise} */
const all = Promise.all.bind(Promise);

/**
 * register the given handlers for each promise and return a promise which
 * resolves when all promises complete
 * @param {Promise[]} jobs
 * @param {function=} resolve
 * @param {function=} reject
 * @returns {Promise}
 */
function each(jobs, resolve, reject) {
	if (resolve == null) {
		resolve = () => {};
	}
	if (reject == null) {
		reject = (error) => {throw error;};
	}
	return all(jobs.map(async (job) => {
		try {
			resolve(await job);
		} catch (error) {
			reject(error);
		}
	}));
}

module.exports = {all, each};
