const all = Promise.all.bind(Promise);

function unfail(promise) {
	return promise.then((value) => ({value}), (error) => ({error}));
}

function tryAll(promises) {
	return all(promises.map(unfail));
}

module.exports = {all, tryAll};
