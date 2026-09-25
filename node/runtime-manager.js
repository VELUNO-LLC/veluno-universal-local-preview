"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const {spawn} = require("child_process");
const {createVisualEditProxy} = require("./visual-edit");

const IGNORED_DIRECTORIES = new Set([
    ".git",
    ".idea",
    ".vscode",
    ".cache",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "vendor"
]);

function uniquePaths(values, platform) {
    const seen = new Set();
    return values.filter(function (value) {
        if (!value || typeof value !== "string") {
            return false;
        }
        const key = platform === "win32" ? value.toLowerCase() : value;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

function buildPhpCandidates(preferred, platform, env) {
    env = env || {};
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    const candidates = [preferred, env.PHP_BINARY, env.PHP_PATH, "php"];

    if (platform === "darwin") {
        candidates.push(
            "/opt/homebrew/bin/php",
            "/opt/homebrew/opt/php/bin/php",
            "/usr/local/bin/php",
            "/usr/local/opt/php/bin/php",
            "/opt/local/bin/php",
            "/usr/bin/php"
        );
        if (env.HOME) {
            candidates.push(pathApi.join(env.HOME, ".config", "herd-lite", "bin", "php"));
        }
    } else if (platform === "win32") {
        const drive = env.SystemDrive || "C:";
        candidates.push(
            pathApi.join(drive + "\\", "php", "php.exe"),
            pathApi.join(drive + "\\", "xampp", "php", "php.exe"),
            pathApi.join(drive + "\\", "tools", "php", "php.exe")
        );
        if (env.ProgramFiles) {
            candidates.push(pathApi.join(env.ProgramFiles, "PHP", "php.exe"));
        }
        if (env.LOCALAPPDATA) {
            candidates.push(pathApi.join(env.LOCALAPPDATA, "Programs", "PHP", "php.exe"));
        }
    } else {
        candidates.push(
            "/usr/bin/php",
            "/usr/local/bin/php",
            "/snap/bin/php",
            "/opt/php/bin/php"
        );
    }
    return uniquePaths(candidates, platform);
}

async function pathExists(candidate) {
    try {
        await fs.promises.access(candidate, fs.constants.F_OK);
        return true;
    } catch (_error) {
        return false;
    }
}

async function findFirstPhpFile(projectRoot, maxDepth, maxEntries) {
    const queue = [{directory: projectRoot, depth: 0}];
    let visited = 0;

    while (queue.length && visited < maxEntries) {
        const item = queue.shift();
        let entries;
        try {
            entries = await fs.promises.readdir(item.directory, {withFileTypes: true});
        } catch (_error) {
            continue;
        }

        for (const entry of entries) {
            visited += 1;
            if (visited >= maxEntries) {
                break;
            }
            if (entry.isFile() && entry.name.toLowerCase().endsWith(".php")) {
                return path.join(item.directory, entry.name);
            }
            if (entry.isDirectory() && item.depth < maxDepth &&
                    !IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
                queue.push({
                    directory: path.join(item.directory, entry.name),
                    depth: item.depth + 1
                });
            }
        }
    }
    return "";
}

async function detectProject(projectRoot) {
    const stat = await fs.promises.stat(projectRoot);
    if (!stat.isDirectory()) {
        throw new Error("Der Projektpfad ist kein Ordner: " + projectRoot);
    }

    const rootIndex = path.join(projectRoot, "index.php"),
        publicIndex = path.join(projectRoot, "public", "index.php"),
        webIndex = path.join(projectRoot, "web", "index.php"),
        composerFile = path.join(projectRoot, "composer.json"),
        packageFile = path.join(projectRoot, "package.json");

    if (await pathExists(rootIndex)) {
        return {
            kind: "php",
            projectRoot: projectRoot,
            documentRoot: projectRoot,
            servePath: "/",
            entryFile: rootIndex
        };
    }
    if (await pathExists(publicIndex)) {
        return {
            kind: "php",
            projectRoot: projectRoot,
            documentRoot: path.join(projectRoot, "public"),
            servePath: "public/",
            entryFile: publicIndex
        };
    }
    if (await pathExists(webIndex)) {
        return {
            kind: "php",
            projectRoot: projectRoot,
            documentRoot: path.join(projectRoot, "web"),
            servePath: "web/",
            entryFile: webIndex
        };
    }
    if (await pathExists(composerFile)) {
        return {
            kind: "php",
            projectRoot: projectRoot,
            documentRoot: projectRoot,
            servePath: "/",
            entryFile: composerFile
        };
    }

    const phpFile = await findFirstPhpFile(projectRoot, 5, 10000);
    if (phpFile) {
        return {
            kind: "php",
            projectRoot: projectRoot,
            documentRoot: projectRoot,
            servePath: "/",
            entryFile: phpFile
        };
    }

    if (await pathExists(packageFile)) {
        try {
            const packageData = JSON.parse(await fs.promises.readFile(packageFile, "utf8"));
            const dependencies = Object.assign({}, packageData.dependencies, packageData.devDependencies);
            if ((packageData.scripts && packageData.scripts.dev) || dependencies.vite) {
                return {
                    kind: "node",
                    projectRoot: projectRoot,
                    entryFile: packageFile
                };
            }
        } catch (_error) {
            // A malformed package.json does not prevent Phoenix's static preview.
        }
    }

    return {
        kind: "static",
        projectRoot: projectRoot,
        documentRoot: projectRoot,
        servePath: "/"
    };
}

class PreviewRuntimeManager {
    constructor(options) {
        options = options || {};
        this.platform = options.platform || process.platform;
        this.env = options.env || process.env;
        this.spawn = options.spawn || spawn;
        this.onState = options.onState || function () {};
        this.child = null;
        this.previewProxy = null;
        this.stoppingChildren = new WeakSet();
        this.logs = [];
        this.lastRequest = null;
        this.operation = 0;
        this.state = {
            status: "idle",
            kind: "none",
            projectRoot: "",
            url: "",
            port: null,
            logs: []
        };
    }

    getState() {
        return Object.assign({}, this.state, {logs: this.logs.slice()});
    }

    setState(patch) {
        this.state = Object.assign({}, this.state, patch, {logs: this.logs.slice()});
        this.onState(this.getState());
        return this.getState();
    }

    appendLog(source, chunk) {
        String(chunk).split(/\r?\n/).forEach((line) => {
            const cleanLine = line.trim();
            if (cleanLine) {
                this.logs.push("[" + source + "] " + cleanLine);
            }
        });
        if (this.logs.length > 200) {
            this.logs.splice(0, this.logs.length - 200);
        }
        this.state.logs = this.logs.slice();
    }

    async inspectProject(projectRoot) {
        return detectProject(projectRoot);
    }

    async discoverVersionedCandidates() {
        const candidates = [];
        if (this.platform === "darwin") {
            await this.collectVersionedExecutables(
                "/Applications/MAMP/bin/php",
                ["bin", "php"],
                candidates
            );
        } else if (this.platform === "win32") {
            const drive = this.env.SystemDrive || "C:";
            await this.collectVersionedExecutables(
                path.win32.join(drive + "\\", "laragon", "bin", "php"),
                ["php.exe"],
                candidates
            );
        }
        return candidates;
    }

    async collectVersionedExecutables(baseDirectory, suffixParts, output) {
        const pathApi = this.platform === "win32" ? path.win32 : path.posix;
        let entries;
        try {
            entries = await fs.promises.readdir(baseDirectory, {withFileTypes: true});
        } catch (_error) {
            return;
        }
        entries
            .filter((entry) => entry.isDirectory())
            .sort((a, b) => b.name.localeCompare(a.name, undefined, {numeric: true}))
            .forEach((entry) => {
                output.push(pathApi.join(baseDirectory, entry.name, ...suffixParts));
            });
    }

    runAndCapture(command, args, timeoutMs) {
        return new Promise((resolve) => {
            let child;
            try {
                child = this.spawn(command, args, {
                    env: this.env,
                    shell: false,
                    stdio: ["ignore", "pipe", "pipe"],
                    windowsHide: true
                });
            } catch (error) {
                resolve({ok: false, error: error.message, stdout: "", stderr: ""});
                return;
            }

            let stdout = "",
                stderr = "",
                settled = false;
            const finish = (result) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                resolve(result);
            };
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                finish({ok: false, error: "Zeitüberschreitung", stdout: stdout, stderr: stderr});
            }, timeoutMs);

            child.stdout && child.stdout.on("data", (data) => { stdout += data.toString(); });
            child.stderr && child.stderr.on("data", (data) => { stderr += data.toString(); });
            child.once("error", (error) => {
                finish({ok: false, error: error.message, stdout: stdout, stderr: stderr});
            });
            child.once("close", (code) => {
                finish({
                    ok: code === 0,
                    error: code === 0 ? "" : (stderr.trim() || "Exit-Code " + code),
                    stdout: stdout,
                    stderr: stderr
                });
            });
        });
    }

    async validatePhp(executable) {
        if (!executable) {
            return {valid: false, error: "Kein PHP-Programm angegeben."};
        }
        const result = await this.runAndCapture(
            executable,
            ["-r", "echo PHP_VERSION;"],
            5000
        );
        const match = result.stdout.match(/\d+\.\d+(?:\.\d+)?/);
        if (!result.ok || !match) {
            return {
                valid: false,
                executable: executable,
                error: result.error || "Die PHP-Version konnte nicht gelesen werden."
            };
        }
        return {
            valid: true,
            executable: executable,
            version: match[0]
        };
    }

    async findPhp(preferred) {
        const candidates = buildPhpCandidates(preferred, this.platform, this.env)
            .concat(await this.discoverVersionedCandidates());
        for (const candidate of uniquePaths(candidates, this.platform)) {
            const validation = await this.validatePhp(candidate);
            if (validation.valid) {
                return validation;
            }
        }
        return null;
    }

    findFreePort() {
        return new Promise((resolve, reject) => {
            const server = net.createServer();
            server.unref();
            server.once("error", reject);
            server.listen(0, "127.0.0.1", function () {
                const address = server.address();
                server.close(function (error) {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(address.port);
                    }
                });
            });
        });
    }

    canConnect(port) {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection({host: "127.0.0.1", port: port});
            socket.setTimeout(250);
            socket.once("connect", function () {
                socket.destroy();
                resolve();
            });
            socket.once("timeout", function () {
                socket.destroy();
                reject(new Error("timeout"));
            });
            socket.once("error", reject);
        });
    }

    async waitForPort(port, child, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (child.previewSpawnError) {
                throw child.previewSpawnError;
            }
            if (child.exitCode !== null) {
                throw new Error("PHP wurde vor dem Serverstart beendet (Exit-Code " + child.exitCode + ").");
            }
            try {
                await this.canConnect(port);
                return;
            } catch (_error) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }
        throw new Error("PHP hat den lokalen Port nicht rechtzeitig geöffnet.");
    }

    async startPreview(options) {
        options = options || {};
        const operation = ++this.operation;
        this.lastRequest = Object.assign({}, options);
        this.logs = [];
        await this.stopProxy();
        await this.stopChild();

        if (operation !== this.operation) {
            return this.getState();
        }

        const php = await this.findPhp(options.phpExecutable);
        if (!php) {
            return this.setState({
                status: "missing-runtime",
                kind: "php",
                projectRoot: options.projectRoot,
                documentRoot: options.documentRoot,
                servePath: options.servePath || "/",
                executable: "",
                version: "",
                url: "",
                port: null,
                error: "PHP wurde nicht gefunden."
            });
        }

        const port = await this.findFreePort();
        if (operation !== this.operation) {
            return this.getState();
        }

        this.setState({
            status: "starting",
            kind: "php",
            projectRoot: options.projectRoot,
            documentRoot: options.documentRoot,
            servePath: options.servePath || "/",
            executable: php.executable,
            version: php.version,
            url: "",
            port: port,
            error: ""
        });

        let child;
        try {
            child = this.spawn(
                php.executable,
                ["-S", "127.0.0.1:" + port, "-t", options.documentRoot],
                {
                    cwd: options.projectRoot,
                    env: this.env,
                    shell: false,
                    stdio: ["ignore", "pipe", "pipe"],
                    windowsHide: true
                }
            );
        } catch (error) {
            return this.setState({
                status: "error",
                url: "",
                port: null,
                error: error.message
            });
        }
        this.child = child;
        child.stdout && child.stdout.on("data", (data) => this.appendLog("php", data));
        child.stderr && child.stderr.on("data", (data) => this.appendLog("php", data));
        child.once("error", (error) => {
            child.previewSpawnError = error;
            this.appendLog("error", error.message);
        });
        child.once("exit", (code, signal) => {
            const isCurrent = this.child === child;
            if (isCurrent) {
                this.child = null;
            }
            if (isCurrent && !this.stoppingChildren.has(child)) {
                this.stopProxy().catch(function () {});
                this.setState({
                    status: "error",
                    url: "",
                    port: null,
                    error: "PHP wurde unerwartet beendet (" +
                        (signal || "Exit-Code " + code) + ")."
                });
            }
        });

        try {
            await this.waitForPort(port, child, 8000);
            if (operation !== this.operation || this.child !== child) {
                return this.getState();
            }
            this.previewProxy = await createVisualEditProxy({
                projectRoot: options.projectRoot,
                documentRoot: options.documentRoot,
                upstreamPort: port
            });
            if (operation !== this.operation || this.child !== child) {
                await this.stopProxy();
                return this.getState();
            }
            return this.setState({
                status: "running",
                url: this.previewProxy.url,
                port: this.previewProxy.port,
                runtimePort: port,
                visualEdit: true,
                error: ""
            });
        } catch (error) {
            await this.stopChild();
            return this.setState({
                status: "error",
                url: "",
                port: null,
                error: error.message
            });
        }
    }

    async stopChild() {
        const child = this.child;
        if (!child) {
            return;
        }
        this.child = null;
        this.stoppingChildren.add(child);
        if (child.exitCode !== null) {
            return;
        }

        const exited = new Promise((resolve) => child.once("exit", resolve));
        try {
            child.kill("SIGTERM");
        } catch (_error) {
            return;
        }
        await Promise.race([
            exited,
            new Promise((resolve) => setTimeout(resolve, 1500))
        ]);
        if (child.exitCode === null) {
            try {
                child.kill("SIGKILL");
            } catch (_error) {
                // The process may have exited between the check and kill call.
            }
        }
    }

    async stopProxy() {
        const proxy = this.previewProxy;
        this.previewProxy = null;
        if (proxy) {
            await proxy.close().catch(function () {});
        }
    }

    async stopPreview() {
        ++this.operation;
        await this.stopProxy();
        await this.stopChild();
        return this.setState({
            status: "stopped",
            url: "",
            port: null,
            error: ""
        });
    }

    async shutdown() {
        ++this.operation;
        await this.stopProxy();
        await this.stopChild();
        return this.setState({
            status: "idle",
            url: "",
            port: null,
            error: ""
        });
    }

    forceStop() {
        if (this.previewProxy && this.previewProxy.server) {
            this.previewProxy.server.close();
            this.previewProxy = null;
        }
        if (!this.child || this.child.exitCode !== null) {
            return;
        }
        try {
            this.child.kill("SIGKILL");
        } catch (_error) {
            // The process is already gone.
        }
    }
}

exports.PreviewRuntimeManager = PreviewRuntimeManager;
exports.buildPhpCandidates = buildPhpCandidates;
exports.detectProject = detectProject;
