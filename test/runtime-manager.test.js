"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const {
    PreviewRuntimeManager,
    buildPhpCandidates,
    detectProject
} = require("../node/runtime-manager");
const {EDIT_ROUTE} = require("../node/visual-edit");

function postJson(url, token, body) {
    return new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify(body));
        const request = http.request(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "content-length": payload.length,
                "x-veluno-preview-token": token
            }
        }, function (response) {
            let responseBody = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => { responseBody += chunk; });
            response.on("end", function () {
                resolve({statusCode: response.statusCode, body: JSON.parse(responseBody)});
            });
        });
        request.on("error", reject);
        request.end(payload);
    });
}

async function withTempProject(run) {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "phoenix-preview-test-"));
    try {
        await run(directory);
    } finally {
        await fs.promises.rm(directory, {recursive: true, force: true});
    }
}

test("PHP candidate order starts with the saved executable", function () {
    const candidates = buildPhpCandidates(
        "/custom/php",
        "darwin",
        {HOME: "/Users/test", PHP_PATH: "/env/php"}
    );
    assert.equal(candidates[0], "/custom/php");
    assert.equal(candidates[1], "/env/php");
    assert.ok(candidates.includes("php"));
    assert.ok(candidates.includes("/opt/homebrew/bin/php"));
});

test("Windows candidates are emitted without a shell command", function () {
    const candidates = buildPhpCandidates("", "win32", {
        SystemDrive: "D:",
        ProgramFiles: "D:\\Program Files"
    });
    assert.ok(candidates.includes("php"));
    assert.ok(candidates.includes("D:\\php\\php.exe"));
    assert.ok(candidates.includes("D:\\xampp\\php\\php.exe"));
    assert.ok(candidates.every((candidate) => !/[;&|]/.test(candidate)));
});

test("root index.php is detected as a PHP project", async function () {
    await withTempProject(async function (directory) {
        await fs.promises.writeFile(path.join(directory, "index.php"), "<?php echo 'ok';");
        const result = await detectProject(directory);
        assert.equal(result.kind, "php");
        assert.equal(result.documentRoot, directory);
        assert.equal(result.servePath, "/");
    });
});

test("public/index.php selects public as document root", async function () {
    await withTempProject(async function (directory) {
        await fs.promises.mkdir(path.join(directory, "public"));
        await fs.promises.writeFile(path.join(directory, "public", "index.php"), "<?php");
        const result = await detectProject(directory);
        assert.equal(result.kind, "php");
        assert.equal(result.documentRoot, path.join(directory, "public"));
        assert.equal(result.servePath, "public/");
    });
});

test("PHP files inside vendor do not turn a static site into PHP", async function () {
    await withTempProject(async function (directory) {
        await fs.promises.mkdir(path.join(directory, "vendor"));
        await fs.promises.writeFile(path.join(directory, "vendor", "library.php"), "<?php");
        await fs.promises.writeFile(path.join(directory, "index.html"), "hello");
        const result = await detectProject(directory);
        assert.equal(result.kind, "static");
    });
});

test("Vite projects are identified but not executed by the PHP adapter", async function () {
    await withTempProject(async function (directory) {
        await fs.promises.writeFile(path.join(directory, "package.json"), JSON.stringify({
            scripts: {dev: "vite"},
            devDependencies: {vite: "latest"}
        }));
        const result = await detectProject(directory);
        assert.equal(result.kind, "node");
    });
});

test("free port allocation returns a usable TCP port", async function () {
    const manager = new PreviewRuntimeManager();
    const port = await manager.findFreePort();
    assert.ok(Number.isInteger(port));
    assert.ok(port > 0 && port < 65536);
});

test("PHP integration serves a project and stops cleanly", async function (context) {
    await withTempProject(async function (directory) {
        await fs.promises.writeFile(
            path.join(directory, "index.php"),
            "<!doctype html><html><body><p>phoenix-preview-ok</p></body></html>"
        );
        const manager = new PreviewRuntimeManager();
        const state = await manager.startPreview({
            projectRoot: directory,
            documentRoot: directory,
            servePath: "/",
            phpExecutable: process.env.PHP_TEST_BINARY || "php"
        });
        if (state.status === "missing-runtime") {
            context.skip("PHP is not installed on this test machine");
            return;
        }
        assert.equal(state.status, "running", state.error);

        const responseBody = await new Promise((resolve, reject) => {
            http.get(state.url, function (response) {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk) => { body += chunk; });
                response.on("end", () => resolve(body));
            }).on("error", reject);
        });
        assert.match(responseBody, /phoenix-preview-ok/);
        assert.match(responseBody, /data-veluno-preview-editor/);
        assert.ok(state.runtimePort > 0);
        assert.notEqual(state.port, state.runtimePort);

        const tokenMatch = responseBody.match(/editor\.js\?token=([a-f0-9]+)/);
        assert.ok(tokenMatch, "editor token was injected");
        const editResponse = await postJson(new URL(EDIT_ROUTE, state.url), tokenMatch[1], {
            requestPath: "/index.php",
            oldText: "phoenix-preview-ok",
            newText: "direkt-bearbeitet"
        });
        assert.equal(editResponse.statusCode, 200);
        assert.equal(editResponse.body.file, "index.php");
        assert.match(
            await fs.promises.readFile(path.join(directory, "index.php"), "utf8"),
            /direkt-bearbeitet/
        );

        const stopped = await manager.stopPreview();
        assert.equal(stopped.status, "stopped");
        assert.equal(stopped.url, "");
    });
});
