const headRegex = /<head>([^]*?)(\t*)?<\/head>/;

/**
 * create script tag
 * @param {string} deps
 * @param {string} main
 * @returns {string}
 */
function onLoad(deps, main) {
	return "<script>" +
		"document.getElementById(\"pre-req\").onload = () => {" +
			`preload.define(${deps});` +
			`preload.main("${main}")` +
		"};" +
	"</script>\n";
}

/**
 * fill the head tag with scripts
 * @param {string} p1
 * @param {string} p2
 * @param {string} preload
 * @param {string} deps
 * @param {string} main
 * @returns {string}
 */
function addScripts(p1, p2, preload, deps, main) {
	p2 = p2 || "";
	return "<head>" +
		p1 +
		`\n<script id="pre-req" src="${preload}" async></script>\n` +
		onLoad(deps, main) +
		(p2 ? p2 : "") +
	"</head>";
}

/**
 * fills a template with scripts
 * @param {string} template
 * @param {string} preload
 * @param {string} deps
 * @param {string} main
 * @returns {string}
 */
function fillTemplate(template, preload, deps, main) {
	return template.replace(
		headRegex,
		(_, p1, p2) => addScripts(p1, p2, preload, deps, main)
	);
}

module.exports = fillTemplate;
