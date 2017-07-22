const headRegex = /<head>([^]*?)(\t*)?<\/head>/;

function onLoad(deps, main) {
	return "<script>" +
		"document.getElementById(\"pre-req\").onload = () => {" +
			`preload.define(${deps});` +
			`preload.main("${main}")` +
		"};" +
	"</script>\n";
}

function addScripts(p1, p2, preload, deps, main) {
	p2 = p2 || "";
	return "<head>" +
		p1 +
		`\n<script id="pre-req" src="${preload}" async></script>\n` +
		onLoad(deps, main) +
		(p2 ? p2 : "") +
	"</head>";
}

function fillTemplate(template, preload, deps, main) {
	return template.replace(
		headRegex,
		(_, p1, p2) => addScripts(p1, p2, preload, deps, main)
	);
}

module.exports = fillTemplate;
