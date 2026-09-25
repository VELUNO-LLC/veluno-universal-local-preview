"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    applyTextEdit,
    editorScript,
    findMatchesInMarkup,
    findMatchesInPhpStrings,
    injectEditor,
    removePreviewBlockingMeta,
    resolveRequestedFile,
    sanitizePreviewHeaders
} = require("../node/visual-edit");

async function withTempProject(run) {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "phoenix-visual-edit-test-"));
    try {
        await run(directory);
    } finally {
        await fs.promises.rm(directory, {recursive: true, force: true});
    }
}

test("literal HTML text in a PHP file is edited atomically", async function () {
    await withTempProject(async function (directory) {
        const file = path.join(directory, "index.php");
        await fs.promises.writeFile(file, "<?php $title = 'dynamic'; ?>\n<p>Alter sichtbarer Text</p>\n");

        const result = await applyTextEdit({
            projectRoot: directory,
            documentRoot: directory,
            requestPath: "/index.php",
            oldText: "Alter sichtbarer Text",
            newText: "Neuer & sicherer Text"
        });

        assert.equal(result.file, "index.php");
        assert.equal(result.line, 2);
        assert.match(await fs.promises.readFile(file, "utf8"), /Neuer &amp; sicherer Text/);
    });
});

test("composed PHP expressions are never guessed from their rendered output", async function () {
    await withTempProject(async function (directory) {
        const file = path.join(directory, "index.php");
        const original = "<?php $title = 'Alter sichtbarer ' . 'Text'; ?>\n<h1><?= $title ?></h1>\n";
        await fs.promises.writeFile(file, original);

        await assert.rejects(applyTextEdit({
            projectRoot: directory,
            documentRoot: directory,
            requestPath: "/",
            oldText: "Alter sichtbarer Text",
            newText: "Nicht schreiben"
        }), /dynamisch erzeugt/);
        assert.equal(await fs.promises.readFile(file, "utf8"), original);
    });
});

test("a unique static PHP string can be edited without breaking its quote", async function () {
    await withTempProject(async function (directory) {
        const file = path.join(directory, "index.php");
        await fs.promises.writeFile(
            file,
            "<?php $copy = ['title' => 'Alter sichtbarer Text']; ?>\n<h1><?= htmlspecialchars($copy['title']) ?></h1>"
        );
        const result = await applyTextEdit({
            projectRoot: directory,
            documentRoot: directory,
            requestPath: "/",
            oldText: "Alter sichtbarer Text",
            newText: "O'Hara \\ Team"
        });
        const updated = await fs.promises.readFile(file, "utf8");
        assert.equal(result.file, "index.php");
        assert.match(updated, /O\\'Hara \\\\ Team/);
        assert.equal(findMatchesInPhpStrings(updated, "O'Hara \\ Team").length, 1);
    });
});

test("comments and double-quoted PHP strings are not mistaken for safe static values", function () {
    const source = "<?php // 'Kommentar'\n$a = \"It's dynamic\"; /* 'Block' */ ?>";
    assert.equal(findMatchesInPhpStrings(source, "Kommentar").length, 0);
    assert.equal(findMatchesInPhpStrings(source, "s dynamic").length, 0);
    assert.equal(findMatchesInPhpStrings(source, "Block").length, 0);
});

test("ambiguous markup is refused instead of guessing", async function () {
    await withTempProject(async function (directory) {
        const file = path.join(directory, "index.php");
        const original = "<p>Gleicher Text</p><footer>Gleicher Text</footer>";
        await fs.promises.writeFile(file, original);

        await assert.rejects(applyTextEdit({
            projectRoot: directory,
            documentRoot: directory,
            requestPath: "/",
            oldText: "Gleicher Text",
            newText: "Unklar"
        }), /2-mal/);
        assert.equal(await fs.promises.readFile(file, "utf8"), original);
    });
});

test("directory URLs resolve to their PHP index inside the document root", async function () {
    await withTempProject(async function (directory) {
        await fs.promises.mkdir(path.join(directory, "kontakt"));
        const file = path.join(directory, "kontakt", "index.php");
        await fs.promises.writeFile(file, "<p>Kontakt</p>");
        assert.equal(await resolveRequestedFile(directory, "/kontakt/"), file);
        assert.equal(await resolveRequestedFile(directory, "/../../etc/passwd"), "");
    });
});

test("editor assets are injected once before the closing body", function () {
    const once = injectEditor("<html><body><p>Hallo</p></body></html>", "token");
    const twice = injectEditor(once, "token");
    assert.match(once, /data-veluno-preview-editor/);
    assert.match(once, /<\/script><\/body>/);
    assert.equal(twice, once);
});

test("preview headers allow secure sites to render inside Phoenix", function () {
    const result = sanitizePreviewHeaders({
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
        "content-security-policy-report-only": "frame-ancestors 'none'",
        "x-frame-options": "DENY",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
        "cross-origin-resource-policy": "same-origin",
        "content-type": "text/html; charset=UTF-8",
        "x-content-type-options": "nosniff"
    });
    assert.deepEqual(result, {
        "content-type": "text/html; charset=UTF-8",
        "x-content-type-options": "nosniff"
    });
});

test("meta CSP is removed only from the generated local preview", function () {
    const html = [
        "<html><head>",
        "<meta content=\"default-src 'none'\" http-equiv=\"Content-Security-Policy\">",
        "<meta http-equiv='content-security-policy-report-only' content=\"default-src 'none'\">",
        "<meta name=\"description\" content=\"bleibt erhalten\">",
        "</head><body>Vorschau</body></html>"
    ].join("");
    const result = removePreviewBlockingMeta(html);
    assert.doesNotMatch(result, /content-security-policy/i);
    assert.match(result, /name=\"description\"/);
    assert.match(result, />Vorschau</);
});

test("the generated browser editor is valid JavaScript", function () {
    assert.doesNotThrow(function () {
        // Parsing is enough here; DOM behavior is covered by the proxy integration.
        Function(editorScript("test-token"));
    });
});

test("markup search ignores identical values inside PHP code", function () {
    const source = "<?php $x = 'Hallo Welt'; ?><p>Hallo Welt</p>";
    const matches = findMatchesInMarkup(source, ".php", "Hallo Welt");
    assert.equal(matches.length, 1);
    assert.equal(source.slice(matches[0].start, matches[0].end), "Hallo Welt");
});

test("markup search ignores attributes, comments, scripts and styles", function () {
    const source = [
        "<meta content=\"Sichtbarer Text\">",
        "<!-- Sichtbarer Text -->",
        "<script>var title = 'Sichtbarer Text';</script>",
        "<style>.x::after { content: 'Sichtbarer Text'; }</style>",
        "<p>Sichtbarer Text</p>"
    ].join("\n");
    const matches = findMatchesInMarkup(source, ".html", "Sichtbarer Text");
    assert.equal(matches.length, 1);
    assert.equal(source.slice(matches[0].start, matches[0].end), "Sichtbarer Text");
});
