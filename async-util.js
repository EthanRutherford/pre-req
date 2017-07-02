const all = Promise.all.bind(Promise);

async function each(jobs, resolve, reject) {
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
