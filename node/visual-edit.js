"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const EDIT_ROUTE = "/.veluno-preview/edit";
const SCRIPT_ROUTE = "/.veluno-preview/editor.js";
const STYLE_ROUTE = "/.veluno-preview/editor.css";
const EDITABLE_EXTENSIONS = new Set([".php", ".html", ".htm"]);
const IGNORED_DIRECTORIES = new Set([
    ".git", ".idea", ".vscode", ".cache", "build", "coverage", "dist",
    "node_modules", "vendor"
]);
const PREVIEW_BLOCKING_HEADERS = new Set([
    "content-security-policy",
    "content-security-policy-report-only",
    "cross-origin-embedder-policy",
    "cross-origin-opener-policy",
    "cross-origin-resource-policy",
    "x-frame-options"
]);

function isInside(root, candidate) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." &&
        !path.isAbsolute(relative));
}

function escapeHtmlText(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function lineNumberAt(source, index) {
    return source.slice(0, index).split(/\r?\n/).length;
}

function outsidePhpSegments(source, extension) {
    if (extension !== ".php") {
        return [{start: 0, end: source.length}];
    }
    const segments = [];
    let cursor = 0;
    while (cursor < source.length) {
        const phpStart = source.indexOf("<?", cursor);
        if (phpStart === -1) {
            segments.push({start: cursor, end: source.length});
            break;
        }
        if (phpStart > cursor) {
            segments.push({start: cursor, end: phpStart});
        }
        const phpEnd = source.indexOf("?>", phpStart + 2);
        if (phpEnd === -1) {
            break;
        }
        cursor = phpEnd + 2;
    }
    return segments;
}

function regexEscape(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function htmlForbiddenRanges(source) {
    const ranges = [];
    const expression = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
    let match;
    while ((match = expression.exec(source))) {
        ranges.push({start: match.index, end: match.index + match[0].length});
    }
    return ranges;
}

function isSafeMarkupMatch(source, start, end, forbiddenRanges) {
    const lastOpen = source.lastIndexOf("<", start);
    const lastClose = source.lastIndexOf(">", start);
    if (lastOpen > lastClose) {
        return false;
    }
    return !forbiddenRanges.some((range) => start < range.end && end > range.start);
}

function findMatchesInMarkup(source, extension, oldText) {
    const segments = outsidePhpSegments(source, extension);
    const forbiddenRanges = htmlForbiddenRanges(source);
    const variants = [String(oldText), escapeHtmlText(oldText)]
        .filter((value, index, all) => value && all.indexOf(value) === index);
    const exactMatches = [];

    for (const segment of segments) {
        for (const variant of variants) {
            let position = segment.start;
            while (position < segment.end) {
                const found = source.indexOf(variant, position);
                if (found === -1 || found + variant.length > segment.end) {
                    break;
                }
                if (isSafeMarkupMatch(source, found, found + variant.length, forbiddenRanges)) {
                    exactMatches.push({start: found, end: found + variant.length, kind: "markup"});
                }
                position = found + Math.max(variant.length, 1);
            }
        }
    }

    const uniqueExact = exactMatches.filter((match, index, all) =>
        all.findIndex((other) => other.start === match.start && other.end === match.end) === index
    );
    if (uniqueExact.length) {
        return uniqueExact;
    }

    const words = String(oldText).trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) {
        return [];
    }
    const flexible = new RegExp(words.map(regexEscape).join("\\s+"), "gu");
    const flexibleMatches = [];
    for (const segment of segments) {
        flexible.lastIndex = segment.start;
        let match;
        while ((match = flexible.exec(source)) && match.index < segment.end) {
            if (match.index + match[0].length <= segment.end && isSafeMarkupMatch(
                    source,
                    match.index,
                    match.index + match[0].length,
                    forbiddenRanges
                )) {
                flexibleMatches.push({
                    start: match.index,
                    end: match.index + match[0].length,
                    kind: "markup"
                });
            }
            if (!match[0].length) {
                flexible.lastIndex += 1;
            }
        }
    }
    return flexibleMatches;
}

function phpSegments(source) {
    const segments = [];
    let cursor = 0;
    while (cursor < source.length) {
        const start = source.indexOf("<?", cursor);
        if (start === -1) {
            break;
        }
        const endMarker = source.indexOf("?>", start + 2);
        const end = endMarker === -1 ? source.length : endMarker;
        segments.push({start: start + 2, end: end});
        if (endMarker === -1) {
            break;
        }
        cursor = endMarker + 2;
    }
    return segments;
}

function decodePhpSingleQuoted(raw) {
    let decoded = "";
    for (let index = 0; index < raw.length; index += 1) {
        if (raw[index] === "\\" && (raw[index + 1] === "\\" || raw[index + 1] === "'")) {
            decoded += raw[index + 1];
            index += 1;
        } else {
            decoded += raw[index];
        }
    }
    return decoded;
}

function findMatchesInPhpStrings(source, oldText) {
    const wanted = String(oldText).trim();
    if (!wanted) {
        return [];
    }
    const matches = [];
    for (const segment of phpSegments(source)) {
        let cursor = segment.start;
        while (cursor < segment.end) {
            if (source.startsWith("//", cursor) || source[cursor] === "#") {
                const lineEnd = source.indexOf("\n", cursor + 1);
                cursor = lineEnd === -1 || lineEnd >= segment.end ? segment.end : lineEnd + 1;
                continue;
            }
            if (source.startsWith("/*", cursor)) {
                const commentEnd = source.indexOf("*/", cursor + 2);
                cursor = commentEnd === -1 || commentEnd >= segment.end ? segment.end : commentEnd + 2;
                continue;
            }
            if (source[cursor] === "\"" || source[cursor] === "`") {
                const quote = source[cursor];
                cursor += 1;
                while (cursor < segment.end) {
                    if (source[cursor] === "\\") {
                        cursor += 2;
                        continue;
                    }
                    if (source[cursor] === quote) {
                        cursor += 1;
                        break;
                    }
                    cursor += 1;
                }
                continue;
            }
            if (source[cursor] !== "'") {
                cursor += 1;
                continue;
            }

            const contentStart = cursor + 1;
            let contentEnd = contentStart;
            while (contentEnd < segment.end) {
                if (source[contentEnd] === "\\") {
                    contentEnd += 2;
                    continue;
                }
                if (source[contentEnd] === "'") {
                    break;
                }
                contentEnd += 1;
            }
            if (contentEnd >= segment.end) {
                break;
            }
            const decoded = decodePhpSingleQuoted(source.slice(contentStart, contentEnd));
            if (decoded.trim() === wanted) {
                matches.push({start: contentStart, end: contentEnd, kind: "php-single"});
            }
            cursor = contentEnd + 1;
        }
    }
    return matches;
}

function replacementForMatch(match, newText) {
    if (match.kind === "php-single") {
        return String(newText).trim().replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    }
    return escapeHtmlText(String(newText).trim());
}

async function listEditableFiles(projectRoot, maxEntries) {
    const files = [];
    const queue = [projectRoot];
    let visited = 0;
    while (queue.length && visited < maxEntries) {
        const directory = queue.shift();
        let entries;
        try {
            entries = await fs.promises.readdir(directory, {withFileTypes: true});
        } catch (_error) {
            continue;
        }
        for (const entry of entries) {
            visited += 1;
            if (visited > maxEntries) {
                break;
            }
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
                queue.push(entryPath);
            } else if (entry.isFile() && EDITABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                files.push(entryPath);
            }
        }
    }
    return files;
}

async function resolveRequestedFile(documentRoot, requestPath) {
    let pathname;
    try {
        pathname = new URL(requestPath || "/", "http://127.0.0.1").pathname;
        pathname = decodeURIComponent(pathname);
    } catch (_error) {
        return "";
    }
    const relative = pathname.replace(/^[/\\]+/, "").replace(/[/\\]+/g, path.sep);
    const candidate = path.resolve(documentRoot, relative || ".");
    if (!isInside(documentRoot, candidate)) {
        return "";
    }

    const candidates = [candidate];
    if (!path.extname(candidate)) {
        candidates.push(candidate + ".php", candidate + ".html");
    }
    candidates.push(path.join(candidate, "index.php"), path.join(candidate, "index.html"));
    for (const item of candidates) {
        if (!isInside(documentRoot, item) || !EDITABLE_EXTENSIONS.has(path.extname(item).toLowerCase())) {
            continue;
        }
        try {
            if ((await fs.promises.stat(item)).isFile()) {
                return item;
            }
        } catch (_error) {
            // Try the next URL-to-file convention.
        }
    }
    return "";
}

async function atomicWrite(filePath, content) {
    const stat = await fs.promises.stat(filePath);
    const temporary = path.join(
        path.dirname(filePath),
        "." + path.basename(filePath) + ".veluno-preview-" + process.pid + "-" + Date.now() + ".tmp"
    );
    let handle;
    try {
        handle = await fs.promises.open(temporary, "wx", stat.mode);
        await handle.writeFile(content, "utf8");
        await handle.close();
        handle = null;
        await fs.promises.rename(temporary, filePath);
    } catch (error) {
        if (handle) {
            await handle.close().catch(function () {});
        }
        await fs.promises.unlink(temporary).catch(function () {});
        throw error;
    }
}

async function applyTextEdit(options) {
    const projectRoot = path.resolve(options.projectRoot);
    const documentRoot = path.resolve(options.documentRoot || projectRoot);
    const oldText = String(options.oldText || "");
    const newText = String(options.newText || "");
    if (!oldText.trim()) {
        throw Object.assign(new Error("Leerer Text kann nicht zugeordnet werden."), {statusCode: 400});
    }
    if (newText.length > 100000) {
        throw Object.assign(new Error("Der bearbeitete Text ist zu groß."), {statusCode: 413});
    }

    const requestedFile = await resolveRequestedFile(documentRoot, options.requestPath);
    const allFiles = await listEditableFiles(projectRoot, 20000);
    const orderedFiles = requestedFile ?
        [requestedFile].concat(allFiles.filter((file) => file !== requestedFile)) : allFiles;
    const matches = [];

    for (const filePath of orderedFiles) {
        if (!isInside(projectRoot, filePath)) {
            continue;
        }
        let source;
        try {
            source = await fs.promises.readFile(filePath, "utf8");
        } catch (_error) {
            continue;
        }
        const extension = path.extname(filePath).toLowerCase();
        const fileMatches = findMatchesInMarkup(source, extension, oldText)
            .concat(extension === ".php" ? findMatchesInPhpStrings(source, oldText) : []);
        for (const match of fileMatches) {
            matches.push({
                filePath: filePath,
                source: source,
                start: match.start,
                end: match.end,
                kind: match.kind
            });
        }
        if (filePath === requestedFile && fileMatches.length === 1) {
            break;
        }
    }

    if (!matches.length) {
        throw Object.assign(new Error(
            "Der Text wird dynamisch erzeugt oder konnte keiner HTML-Stelle in PHP zugeordnet werden."
        ), {statusCode: 409});
    }
    if (matches.length !== 1) {
        throw Object.assign(new Error(
            "Der Text kommt " + matches.length + "-mal im Projekt vor. Bitte direkt im Code bearbeiten."
        ), {statusCode: 409});
    }

    const match = matches[0];
    const replacement = replacementForMatch(match, newText);
    const updated = match.source.slice(0, match.start) + replacement + match.source.slice(match.end);
    await atomicWrite(match.filePath, updated);
    return {
        ok: true,
        file: path.relative(projectRoot, match.filePath).split(path.sep).join("/"),
        line: lineNumberAt(match.source, match.start)
    };
}

function editorStyle() {
    return [
        ".veluno-preview-editable-hover{outline:2px dashed #18a0fb!important;outline-offset:3px!important;cursor:text!important}",
        ".veluno-preview-editing{outline:3px solid #18a0fb!important;outline-offset:3px!important;cursor:text!important}",
        "#veluno-preview-badge{position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:8px 11px;border-radius:8px;background:#15191f;color:#fff;font:600 12px/1.25 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 4px 18px #0008;pointer-events:none}",
        "#veluno-preview-toast{position:fixed;left:50%;bottom:58px;transform:translateX(-50%);z-index:2147483647;max-width:min(560px,calc(100vw - 24px));padding:10px 14px;border-radius:8px;background:#15191f;color:#fff;font:500 13px/1.35 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 4px 18px #0008}",
        "#veluno-preview-toast[data-error=true]{background:#9f2635}"
    ].join("\n");
}

function editorScript(token) {
    return `"use strict";
(function () {
    if (window.__velunoPreviewEditor) { return; }
    window.__velunoPreviewEditor = true;
    var selector = "p,h1,h2,h3,h4,h5,h6,span,li,dt,dd,figcaption,blockquote,small,strong,em,label,a,button";
    var active = null;
    var hover = null;
    var saving = false;
    var token = ${JSON.stringify(token)};

    function candidate(target) {
        var element = target && target.closest ? target.closest(selector) : null;
        if (!element || element.closest("#veluno-preview-badge,#veluno-preview-toast") ||
                !element.textContent.trim()) {
            return null;
        }
        return element;
    }

    function makeEditable(element, event) {
        if (!element.childElementCount) { return element; }
        var range = document.caretRangeFromPoint ?
            document.caretRangeFromPoint(event.clientX, event.clientY) : null;
        var textNode = range && range.startContainer && range.startContainer.nodeType === 3 ?
            range.startContainer : null;
        if (!textNode || !element.contains(textNode) || !textNode.nodeValue.trim()) {
            var walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            var found = [];
            var node;
            while ((node = walker.nextNode())) {
                if (node.nodeValue.trim()) { found.push(node); }
            }
            textNode = found.length === 1 ? found[0] : null;
        }
        if (!textNode) { return null; }
        var wrapper = document.createElement("span");
        wrapper.dataset.velunoTemporaryWrapper = "true";
        textNode.parentNode.insertBefore(wrapper, textNode);
        wrapper.appendChild(textNode);
        return wrapper;
    }

    function restoreTemporary(element, text) {
        if (element.dataset.velunoTemporaryWrapper === "true" && element.parentNode) {
            element.replaceWith(document.createTextNode(text));
        } else {
            element.textContent = text;
        }
    }

    function toast(message, error) {
        var old = document.getElementById("veluno-preview-toast");
        if (old) { old.remove(); }
        var node = document.createElement("div");
        node.id = "veluno-preview-toast";
        node.dataset.error = error ? "true" : "false";
        node.textContent = message;
        document.documentElement.appendChild(node);
        window.setTimeout(function () { if (node.parentNode) { node.remove(); } }, error ? 6000 : 2800);
    }

    function finish(element, cancel) {
        if (!element || saving) { return; }
        var oldText = element.__velunoOldText || "";
        var newText = element.textContent;
        element.removeAttribute("contenteditable");
        element.removeAttribute("spellcheck");
        element.classList.remove("veluno-preview-editing");
        active = null;
        if (cancel || newText.trim() === oldText.trim()) {
            restoreTemporary(element, oldText);
            return;
        }
        saving = true;
        fetch(${JSON.stringify(EDIT_ROUTE)}, {
            method: "POST",
            headers: {"content-type": "application/json", "x-veluno-preview-token": token},
            body: JSON.stringify({requestPath: location.pathname, oldText: oldText.trim(), newText: newText.trim()})
        }).then(function (response) {
            return response.json().then(function (body) { return {ok: response.ok, body: body}; });
        }).then(function (result) {
            if (!result.ok) { throw new Error(result.body.error || "Speichern fehlgeschlagen."); }
            restoreTemporary(element, newText.trim());
            toast("Gespeichert: " + result.body.file + ":" + result.body.line, false);
        }).catch(function (error) {
            restoreTemporary(element, oldText);
            toast(error.message, true);
        }).finally(function () { saving = false; });
    }

    document.addEventListener("mouseover", function (event) {
        if (active) { return; }
        var element = candidate(event.target);
        if (hover && hover !== element) { hover.classList.remove("veluno-preview-editable-hover"); }
        hover = element;
        if (hover) { hover.classList.add("veluno-preview-editable-hover"); }
    }, true);
    document.addEventListener("mouseout", function (event) {
        if (hover && !hover.contains(event.relatedTarget)) {
            hover.classList.remove("veluno-preview-editable-hover");
            hover = null;
        }
    }, true);
    document.addEventListener("dblclick", function (event) {
        var container = candidate(event.target);
        if (!container || saving) { return; }
        event.preventDefault();
        event.stopImmediatePropagation();
        var element = makeEditable(container, event);
        if (!element) { return; }
        if (active && active !== element) { finish(active, false); }
        active = element;
        element.classList.remove("veluno-preview-editable-hover");
        element.classList.add("veluno-preview-editing");
        element.__velunoOldText = element.textContent;
        element.setAttribute("contenteditable", "plaintext-only");
        element.setAttribute("spellcheck", "true");
        element.focus();
        var selection = window.getSelection();
        var range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
    }, true);
    document.addEventListener("keydown", function (event) {
        if (!active) { return; }
        if (event.key === "Escape") {
            event.preventDefault();
            finish(active, true);
        } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            active.blur();
        }
    }, true);
    document.addEventListener("focusout", function (event) {
        if (active && event.target === active) { finish(active, false); }
    }, true);

    var badge = document.createElement("div");
    badge.id = "veluno-preview-badge";
    badge.textContent = "Direktbearbeitung: Text doppelklicken";
    document.documentElement.appendChild(badge);
}());`;
}

function removePreviewBlockingMeta(html) {
    return String(html).replace(
        /<meta\b[^>]*\bhttp-equiv\s*=\s*(?:"content-security-policy(?:-report-only)?"|'content-security-policy(?:-report-only)?'|content-security-policy(?:-report-only)?)[^>]*>/gi,
        ""
    );
}

function sanitizePreviewHeaders(headers) {
    const sanitized = {};
    Object.keys(headers || {}).forEach(function (name) {
        if (!PREVIEW_BLOCKING_HEADERS.has(name.toLowerCase())) {
            sanitized[name] = headers[name];
        }
    });
    return sanitized;
}

function injectEditor(html, token) {
    const previewHtml = removePreviewBlockingMeta(html);
    if (previewHtml.includes("data-veluno-preview-editor")) {
        return previewHtml;
    }
    const assets = "<link rel=\"stylesheet\" href=\"" + STYLE_ROUTE + "?token=" + token +
        "\" data-veluno-preview-editor><script src=\"" + SCRIPT_ROUTE + "?token=" + token +
        "\" defer data-veluno-preview-editor></script>";
    const bodyEnd = previewHtml.toLowerCase().lastIndexOf("</body>");
    return bodyEnd === -1 ? previewHtml + assets :
        previewHtml.slice(0, bodyEnd) + assets + previewHtml.slice(bodyEnd);
}

function jsonResponse(response, statusCode, body) {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    response.writeHead(statusCode, {
        "content-type": "application/json; charset=utf-8",
        "content-length": payload.length,
        "cache-control": "no-store"
    });
    response.end(payload);
}

function readJson(request, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        request.on("data", function (chunk) {
            size += chunk.length;
            if (size > maxBytes) {
                reject(Object.assign(new Error("Anfrage zu groß."), {statusCode: 413}));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", function () {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (_error) {
                reject(Object.assign(new Error("Ungültige Bearbeitungsdaten."), {statusCode: 400}));
            }
        });
        request.on("error", reject);
    });
}

function createVisualEditProxy(options) {
    const token = crypto.randomBytes(24).toString("hex");
    const sockets = new Set();
    const server = http.createServer(async function (request, response) {
        const requestUrl = new URL(request.url, "http://127.0.0.1");
        if (requestUrl.pathname === SCRIPT_ROUTE || requestUrl.pathname === STYLE_ROUTE) {
            if (requestUrl.searchParams.get("token") !== token) {
                response.writeHead(403);
                response.end();
                return;
            }
            const body = requestUrl.pathname === SCRIPT_ROUTE ? editorScript(token) : editorStyle();
            response.writeHead(200, {
                "content-type": requestUrl.pathname === SCRIPT_ROUTE ?
                    "application/javascript; charset=utf-8" : "text/css; charset=utf-8",
                "cache-control": "no-store",
                "content-length": Buffer.byteLength(body)
            });
            response.end(body);
            return;
        }
        if (requestUrl.pathname === EDIT_ROUTE) {
            if (request.method !== "POST" || request.headers["x-veluno-preview-token"] !== token) {
                jsonResponse(response, 403, {error: "Bearbeitungsanfrage nicht erlaubt."});
                return;
            }
            try {
                const body = await readJson(request, 250000);
                const result = await applyTextEdit({
                    projectRoot: options.projectRoot,
                    documentRoot: options.documentRoot,
                    requestPath: body.requestPath,
                    oldText: body.oldText,
                    newText: body.newText
                });
                jsonResponse(response, 200, result);
            } catch (error) {
                jsonResponse(response, error.statusCode || 500, {error: error.message});
            }
            return;
        }

        const headers = Object.assign({}, request.headers, {"accept-encoding": "identity"});
        const upstream = http.request({
            hostname: "127.0.0.1",
            port: options.upstreamPort,
            method: request.method,
            path: request.url,
            headers: headers
        }, function (upstreamResponse) {
            const contentType = String(upstreamResponse.headers["content-type"] || "").toLowerCase();
            if (!contentType.includes("text/html")) {
                response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
                upstreamResponse.pipe(response);
                return;
            }
            const chunks = [];
            upstreamResponse.on("data", (chunk) => chunks.push(chunk));
            upstreamResponse.on("end", function () {
                const body = injectEditor(Buffer.concat(chunks).toString("utf8"), token);
                const responseHeaders = sanitizePreviewHeaders(upstreamResponse.headers);
                delete responseHeaders["content-encoding"];
                delete responseHeaders["transfer-encoding"];
                responseHeaders["content-length"] = Buffer.byteLength(body);
                responseHeaders["cache-control"] = "no-store";
                response.writeHead(upstreamResponse.statusCode, responseHeaders);
                response.end(body);
            });
        });
        upstream.on("error", function (error) {
            if (!response.headersSent) {
                response.writeHead(502, {"content-type": "text/plain; charset=utf-8"});
            }
            response.end("Lokale PHP-Vorschau nicht erreichbar: " + error.message);
        });
        request.pipe(upstream);
    });
    server.on("connection", function (socket) {
        sockets.add(socket);
        socket.once("close", function () { sockets.delete(socket); });
    });

    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", function () {
            server.removeListener("error", reject);
            const port = server.address().port;
            resolve({
                server: server,
                port: port,
                url: "http://127.0.0.1:" + port + "/",
                close: function () {
                    return new Promise((closeResolve) => {
                        server.close(closeResolve);
                        sockets.forEach(function (socket) { socket.destroy(); });
                    });
                }
            });
        });
    });
}

exports.EDIT_ROUTE = EDIT_ROUTE;
exports.applyTextEdit = applyTextEdit;
exports.createVisualEditProxy = createVisualEditProxy;
exports.editorScript = editorScript;
exports.findMatchesInMarkup = findMatchesInMarkup;
exports.findMatchesInPhpStrings = findMatchesInPhpStrings;
exports.injectEditor = injectEditor;
exports.removePreviewBlockingMeta = removePreviewBlockingMeta;
exports.resolveRequestedFile = resolveRequestedFile;
exports.sanitizePreviewHeaders = sanitizePreviewHeaders;
