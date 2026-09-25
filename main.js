/*global define, brackets, Phoenix, $ */

/**
 * Universal Local Preview
 *
 * Phoenix-side controller. Runtime processes live in node/index.js and are
 * reached through NodeConnector. No settings are written into the project.
 */
define(function (require, exports, module) {
    "use strict";

    const AppInit = brackets.getModule("utils/AppInit"),
        CommandManager = brackets.getModule("command/CommandManager"),
        Commands = brackets.getModule("command/Commands"),
        DefaultDialogs = brackets.getModule("widgets/DefaultDialogs"),
        Dialogs = brackets.getModule("widgets/Dialogs"),
        ExtensionInterface = brackets.getModule("utils/ExtensionInterface"),
        ExtensionUtils = brackets.getModule("utils/ExtensionUtils"),
        FileSystem = brackets.getModule("filesystem/FileSystem"),
        Menus = brackets.getModule("command/Menus"),
        NativeApp = brackets.getModule("utils/NativeApp"),
        NodeConnector = brackets.getModule("NodeConnector"),
        PathUtils = require("./path-utils"),
        PreferencesManager = brackets.getModule("preferences/PreferencesManager"),
        ProjectManager = brackets.getModule("project/ProjectManager"),
        StatusBar = brackets.getModule("widgets/StatusBar");

    const CONNECTOR_ID = "veluno-universal-local-preview",
        LIVE_PREVIEW_INTERFACE = "Extn.Phoenix.livePreview",
        STATUS_ID = "status-universal-local-preview",
        MENU_ID = "veluno.previewRuntime.menu",
        COMMAND_START = "veluno.previewRuntime.start",
        COMMAND_RESTART = "veluno.previewRuntime.restart",
        COMMAND_STOP = "veluno.previewRuntime.stop",
        COMMAND_OPEN = "veluno.previewRuntime.openExternal",
        COMMAND_SELECT_PHP = "veluno.previewRuntime.selectPhp",
        LIVE_PREVIEW_METHOD_TIMEOUT = 5000;

    const SESSION_SCOPE = {location: {scope: "session"}},
        LIVE_PREVIEW_PREFS = {
            enabled: "livePreviewUseDevServer",
            url: "livePreviewServerURL",
            path: "livePreviewServerProjectPath",
            hotReload: "livePreviewHotReloadSupported",
            framework: "livePreviewFramework"
        };

    ExtensionUtils.loadStyleSheet(module, "styles.css");

    const extensionState = PreferencesManager.stateManager.createExtensionStateManager(
        "veluno-preview-runtime"
    );

    let nodeConnector = null,
        livePreviewInterface = null,
        currentProjectRoot = "",
        currentInspection = null,
        currentState = {status: "idle", kind: "none"},
        projectGeneration = 0,
        missingRuntimeDialogOpen = false,
        $statusIndicator = null;

    function escapeHTML(value) {
        return String(value === undefined || value === null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function waitForNodeReady(timeoutMs) {
        return new Promise(function (resolve) {
            const deadline = Date.now() + timeoutMs;
            (function check() {
                if (NodeConnector.isNodeReady()) {
                    resolve(true);
                } else if (Date.now() >= deadline) {
                    resolve(false);
                } else {
                    window.setTimeout(check, 200);
                }
            }());
        });
    }

    function toNativePath(inputPath) {
        return PathUtils.toNativePath(inputPath, {
            getVirtualRoot: function () {
                return Phoenix.VFS && typeof Phoenix.VFS.getTauriDir === "function" ?
                    Phoenix.VFS.getTauriDir() : "";
            },
            toPlatformPath: function (virtualPath) {
                return Phoenix.fs.getTauriPlatformPath(virtualPath);
            }
        });
    }

    function stateLabel(state) {
        switch (state.status) {
        case "detecting":
            return "Preview · Erkennung …";
        case "starting":
            return "Preview · PHP startet …";
        case "running":
            return "PHP " + (state.version || "") + " · localhost:" + state.port;
        case "static":
            return "Static · Phoenix Preview";
        case "needs-trust":
            return "PHP · Freigabe erforderlich";
        case "missing-runtime":
            return "PHP · Laufzeit fehlt";
        case "unsupported":
            return (state.kind === "node" ? "Node/Vite" : "Projekt") + " · noch nicht unterstützt";
        case "stopped":
            return "Preview · gestoppt";
        case "error":
            return "Preview · Fehler";
        case "unavailable":
            return "Preview · Desktop erforderlich";
        default:
            return "Preview · bereit";
        }
    }

    function stateTooltip(state) {
        const parts = [stateLabel(state)];
        if (state.projectRoot) {
            parts.push(state.projectRoot);
        }
        if (state.executable) {
            parts.push(state.executable);
        }
        if (state.error) {
            parts.push(state.error);
        }
        return parts.join("\n");
    }

    function updateCommands() {
        const isRunning = currentState.status === "running",
            canStart = currentInspection && currentInspection.kind === "php";
        CommandManager.get(COMMAND_START).setEnabled(!!canStart && !isRunning);
        CommandManager.get(COMMAND_RESTART).setEnabled(!!canStart);
        CommandManager.get(COMMAND_STOP).setEnabled(isRunning || currentState.status === "starting");
        CommandManager.get(COMMAND_OPEN).setEnabled(isRunning && !!currentState.url);
        CommandManager.get(COMMAND_SELECT_PHP).setEnabled(Phoenix.isNativeApp);
    }

    function updateState(state) {
        currentState = Object.assign({}, currentState, state || {});
        if ($statusIndicator) {
            $statusIndicator
                .attr("data-state", currentState.status || "idle")
                .attr("title", stateTooltip(currentState));
            $statusIndicator.find(".preview-runtime-label").text(stateLabel(currentState));
        }
        updateCommands();
    }

    async function getLivePreviewInterface() {
        if (livePreviewInterface) {
            return livePreviewInterface;
        }
        livePreviewInterface = await ExtensionInterface.waitAndGetExtensionInterface(
            LIVE_PREVIEW_INTERFACE
        );
        return livePreviewInterface;
    }

    function delay(milliseconds) {
        return new Promise(function (resolve) {
            window.setTimeout(resolve, milliseconds);
        });
    }

    async function reloadPhoenixPreview() {
        let preview;
        try {
            preview = await getLivePreviewInterface();
        } catch (error) {
            console.warn("[Universal Local Preview] Phoenix preview interface is unavailable", error);
            return false;
        }

        // Phoenix registers the interface before all methods are attached to it.
        // On a fast project startup this extension can therefore receive the
        // interface object a moment before reloadLivePreview becomes available.
        const deadline = Date.now() + LIVE_PREVIEW_METHOD_TIMEOUT;
        while (typeof preview.reloadLivePreview !== "function" && Date.now() < deadline) {
            await delay(50);
        }

        if (typeof preview.reloadLivePreview === "function") {
            preview.reloadLivePreview();
            return true;
        }

        // Older Phoenix builds do not expose reloadLivePreview on the public
        // extension interface, but they still register the reload command.
        const reloadCommand = Commands.CMD_RELOAD_LIVE_PREVIEW;
        if (reloadCommand && CommandManager.get(reloadCommand)) {
            await CommandManager.execute(reloadCommand);
            return true;
        }

        // Preference changes already trigger Phoenix's custom-server refresh,
        // so a missing explicit reload API is not fatal.
        console.warn("[Universal Local Preview] Phoenix has no explicit preview reload API");
        return false;
    }

    function setSessionPreference(id, value) {
        PreferencesManager.set(id, value, SESSION_SCOPE);
    }

    async function activateCustomPreview(state) {
        setSessionPreference(LIVE_PREVIEW_PREFS.url, state.url);
        setSessionPreference(LIVE_PREVIEW_PREFS.path, state.servePath || "/");
        setSessionPreference(LIVE_PREVIEW_PREFS.hotReload, false);
        setSessionPreference(LIVE_PREVIEW_PREFS.framework, null);
        setSessionPreference(LIVE_PREVIEW_PREFS.enabled, true);
        await reloadPhoenixPreview();
    }

    async function clearCustomPreview() {
        Object.keys(LIVE_PREVIEW_PREFS).forEach(function (key) {
            setSessionPreference(LIVE_PREVIEW_PREFS[key], undefined);
        });
        if (livePreviewInterface && typeof livePreviewInterface.reloadLivePreview === "function") {
            livePreviewInterface.reloadLivePreview();
        }
    }

    function onRuntimeStatus(_event, state) {
        if (!state || (state.projectRoot && state.projectRoot !== currentProjectRoot)) {
            return;
        }
        updateState(state);
        if (["error", "missing-runtime", "stopped"].includes(state.status)) {
            clearCustomPreview().catch(console.error);
        }
    }

    function askToTrustProject(projectRoot) {
        const buttons = [
            {
                className: Dialogs.DIALOG_BTN_CLASS_NORMAL,
                id: Dialogs.DIALOG_BTN_CANCEL,
                text: "Nicht starten"
            },
            {
                className: Dialogs.DIALOG_BTN_CLASS_PRIMARY,
                id: Dialogs.DIALOG_BTN_OK,
                text: "Vertrauen und starten"
            }
        ];
        const message = "<p>Dieses Projekt enthält PHP-Dateien. Für die Vorschau wird PHP lokal " +
            "gestartet und der aufgerufene Projektcode ausgeführt.</p>" +
            "<p><strong>Projekt:</strong><br><code>" + escapeHTML(projectRoot) + "</code></p>" +
            "<p>Die Freigabe wird nur lokal in Phoenix gespeichert.</p>";

        return new Promise(function (resolve) {
            Dialogs.showModalDialog(
                DefaultDialogs.DIALOG_ID_INFO,
                "Lokale PHP-Vorschau erlauben?",
                message,
                buttons
            ).done(function (buttonId) {
                resolve(buttonId === Dialogs.DIALOG_BTN_OK);
            });
        });
    }

    async function choosePhpExecutable() {
        if (!nodeConnector) {
            return false;
        }
        const activeProject = ProjectManager.getProjectRoot(),
            dialogInitialPath = activeProject && activeProject.fullPath ? activeProject.fullPath : "";
        const selectedPath = await new Promise(function (resolve) {
            FileSystem.showOpenDialog(
                false,
                false,
                "PHP-Programm auswählen",
                dialogInitialPath,
                null,
                function (_error, files) {
                    resolve(files && files.length ? files[0] : "");
                }
            );
        });
        if (!selectedPath) {
            return false;
        }

        const nativeSelectedPath = toNativePath(selectedPath);

        const validation = await nodeConnector.execPeer("validatePhp", {
            executable: nativeSelectedPath
        });
        if (!validation || !validation.valid) {
            Dialogs.showErrorDialog(
                "PHP konnte nicht gestartet werden",
                "<code>" + escapeHTML(nativeSelectedPath) + "</code><br><br>" +
                escapeHTML((validation && validation.error) || "Ungültiges PHP-Programm.")
            );
            return false;
        }
        extensionState.set("phpExecutable", nativeSelectedPath, extensionState.GLOBAL_CONTEXT);
        return true;
    }

    async function offerPhpSelection(generation) {
        if (missingRuntimeDialogOpen || generation !== projectGeneration) {
            return;
        }
        missingRuntimeDialogOpen = true;
        try {
            const selectNow = await new Promise(function (resolve) {
                Dialogs.showConfirmDialog(
                    "PHP wurde nicht gefunden",
                    "PHP ist nicht im Suchpfad und wurde auch an den üblichen Installationsorten nicht gefunden. " +
                    "Möchtest du das PHP-Programm jetzt auswählen?"
                ).done(function (buttonId) {
                    resolve(buttonId === Dialogs.DIALOG_BTN_OK);
                });
            });
            if (selectNow && generation === projectGeneration && await choosePhpExecutable()) {
                await startPhpPreview(generation);
            }
        } finally {
            missingRuntimeDialogOpen = false;
        }
    }

    async function startPhpPreview(generation) {
        if (!nodeConnector || generation !== projectGeneration || !currentInspection) {
            return;
        }
        const preferredPhp = extensionState.get("phpExecutable", extensionState.GLOBAL_CONTEXT) || "";
        updateState({
            status: "starting",
            kind: "php",
            projectRoot: currentProjectRoot,
            error: ""
        });
        const result = await nodeConnector.execPeer("startPreview", {
            projectRoot: currentProjectRoot,
            documentRoot: currentInspection.documentRoot,
            servePath: currentInspection.servePath,
            phpExecutable: preferredPhp
        });
        if (generation !== projectGeneration) {
            return;
        }
        updateState(result);
        if (result.status === "running") {
            extensionState.set("phpExecutable", result.executable, extensionState.GLOBAL_CONTEXT);
            await activateCustomPreview(result);
        } else if (result.status === "missing-runtime") {
            await clearCustomPreview();
            await offerPhpSelection(generation);
        }
    }

    async function configureProject(projectRoot, options) {
        options = options || {};
        const generation = ++projectGeneration;
        currentProjectRoot = projectRoot || "";
        currentInspection = null;
        await clearCustomPreview();

        if (!nodeConnector || !currentProjectRoot) {
            updateState({status: "idle", kind: "none", projectRoot: currentProjectRoot});
            return;
        }

        updateState({
            status: "detecting",
            kind: "none",
            projectRoot: currentProjectRoot,
            error: ""
        });

        await nodeConnector.execPeer("stopPreview", {});
        const inspection = await nodeConnector.execPeer("inspectProject", {
            projectRoot: currentProjectRoot
        });
        if (generation !== projectGeneration) {
            return;
        }
        currentInspection = inspection;

        if (inspection.kind === "static") {
            updateState({
                status: "static",
                kind: "static",
                projectRoot: currentProjectRoot,
                error: ""
            });
            return;
        }

        if (inspection.kind !== "php") {
            updateState({
                status: "unsupported",
                kind: inspection.kind,
                projectRoot: currentProjectRoot,
                error: ""
            });
            return;
        }

        let trusted = extensionState.get("trustedRuntime", extensionState.PROJECT_CONTEXT) === true;
        const denied = extensionState.get("runtimeDenied", extensionState.PROJECT_CONTEXT) === true;
        if (!trusted && (!denied || options.askAgain)) {
            trusted = await askToTrustProject(currentProjectRoot);
            if (generation !== projectGeneration) {
                return;
            }
            extensionState.set("trustedRuntime", trusted, extensionState.PROJECT_CONTEXT);
            extensionState.set("runtimeDenied", !trusted, extensionState.PROJECT_CONTEXT);
        }

        if (!trusted) {
            updateState({
                status: "needs-trust",
                kind: "php",
                projectRoot: currentProjectRoot,
                error: ""
            });
            return;
        }
        await startPhpPreview(generation);
    }

    async function startCurrentProject() {
        if (!currentProjectRoot) {
            return;
        }
        extensionState.set("runtimeDenied", false, extensionState.PROJECT_CONTEXT);
        await configureProject(currentProjectRoot, {askAgain: true});
    }

    async function stopCurrentPreview() {
        ++projectGeneration;
        if (nodeConnector) {
            await nodeConnector.execPeer("stopPreview", {});
        }
        await clearCustomPreview();
        updateState({
            status: "stopped",
            kind: currentInspection ? currentInspection.kind : "none",
            projectRoot: currentProjectRoot,
            url: "",
            port: null,
            error: ""
        });
    }

    async function restartCurrentPreview() {
        if (!currentProjectRoot) {
            return;
        }
        await configureProject(currentProjectRoot, {askAgain: true});
    }

    function openExternalPreview() {
        if (currentState.url) {
            NativeApp.openURLInDefaultBrowser(currentState.url);
        }
    }

    function showStatusDialog() {
        const logs = (currentState.logs || []).slice(-20).join("\n"),
            details = [
                "<p><strong>Status:</strong> " + escapeHTML(stateLabel(currentState)) + "</p>",
                currentState.projectRoot ? "<p><strong>Projekt:</strong><br><code>" +
                    escapeHTML(currentState.projectRoot) + "</code></p>" : "",
                currentState.executable ? "<p><strong>PHP:</strong><br><code>" +
                    escapeHTML(currentState.executable) + "</code></p>" : "",
                currentState.url ? "<p><strong>URL:</strong><br><code>" +
                    escapeHTML(currentState.url) + "</code></p>" : "",
                currentState.error ? "<p class=\"preview-runtime-error\">" +
                    escapeHTML(currentState.error) + "</p>" : "",
                logs ? "<details><summary>Letzte Servermeldungen</summary><pre>" +
                    escapeHTML(logs) + "</pre></details>" : ""
            ].join("");
        Dialogs.showInfoDialog("Universal Local Preview", details);
    }

    function registerCommandsAndMenu() {
        CommandManager.register("Preview starten", COMMAND_START, function () {
            startCurrentProject().catch(reportManualError);
        });
        CommandManager.register("Preview neu starten", COMMAND_RESTART, function () {
            restartCurrentPreview().catch(reportManualError);
        });
        CommandManager.register("Preview stoppen", COMMAND_STOP, function () {
            stopCurrentPreview().catch(reportManualError);
        });
        CommandManager.register("Im Browser öffnen", COMMAND_OPEN, openExternalPreview);
        CommandManager.register("PHP-Programm auswählen …", COMMAND_SELECT_PHP, function () {
            choosePhpExecutable().then(function (selected) {
                if (selected && currentInspection && currentInspection.kind === "php") {
                    restartCurrentPreview().catch(reportManualError);
                }
            }).catch(reportManualError);
        });

        const fileMenu = Menus.getMenu(Menus.AppMenuBar.FILE_MENU),
            submenu = fileMenu.addSubMenu("Local Preview Runtime", MENU_ID, Menus.LAST);
        submenu.addMenuItem(COMMAND_START);
        submenu.addMenuItem(COMMAND_RESTART);
        submenu.addMenuItem(COMMAND_STOP);
        submenu.addMenuDivider();
        submenu.addMenuItem(COMMAND_OPEN);
        submenu.addMenuDivider();
        submenu.addMenuItem(COMMAND_SELECT_PHP);
    }

    function registerStatusIndicator() {
        $statusIndicator = $(
            "<div class=\"veluno-preview-runtime-status\" data-state=\"idle\">" +
                "<span class=\"preview-runtime-dot\"></span>" +
                "<span class=\"preview-runtime-label\">Preview · bereit</span>" +
            "</div>"
        );
        $statusIndicator.on("click", showStatusDialog);
        StatusBar.addIndicator(STATUS_ID, $statusIndicator, true);
    }

    function reportError(error, showDialog) {
        const message = error && error.message ? error.message : String(error);
        console.error("[Universal Local Preview]", error);
        updateState({status: "error", error: message});
        if (showDialog) {
            Dialogs.showErrorDialog("Universal Local Preview", escapeHTML(message));
        }
    }

    function reportManualError(error) {
        reportError(error, true);
    }

    function projectOpened(_event, projectRoot) {
        const projectPath = projectRoot && projectRoot.fullPath;
        if (isPhoenixInternalProject(projectPath)) {
            currentProjectRoot = "";
            currentInspection = null;
            updateState({status: "idle", kind: "none", projectRoot: ""});
            return;
        }
        configureProject(toNativePath(projectPath)).catch(reportError);
    }

    function isPhoenixInternalProject(projectRoot) {
        if (!projectRoot) {
            return true;
        }
        return ProjectManager.isWelcomeProjectPath(projectRoot) ||
            projectRoot === ProjectManager.getExploreProjectPath() ||
            projectRoot === ProjectManager.getPlaceholderProjectPath();
    }

    function beforeProjectClose() {
        ++projectGeneration;
        clearCustomPreview().catch(console.error);
        if (nodeConnector) {
            nodeConnector.execPeer("stopPreview", {}).catch(console.error);
        }
    }

    AppInit.appReady(async function () {
        registerCommandsAndMenu();
        registerStatusIndicator();
        updateCommands();

        if (!Phoenix.isNativeApp || !NodeConnector.isNodeAvailable()) {
            updateState({status: "unavailable", kind: "none"});
            return;
        }

        nodeConnector = NodeConnector.createNodeConnector(CONNECTOR_ID, exports);
        nodeConnector.on("runtimeStatus", onRuntimeStatus);
        ProjectManager.on(ProjectManager.EVENT_PROJECT_OPEN + ".velunoPreviewRuntime", projectOpened);
        ProjectManager.on(ProjectManager.EVENT_PROJECT_BEFORE_CLOSE + ".velunoPreviewRuntime", beforeProjectClose);
        ProjectManager.on("beforeAppClose.velunoPreviewRuntime", function (_event, exitWaitPromises) {
            const shutdown = nodeConnector.execPeer("shutdown", {}).catch(console.error);
            if (Array.isArray(exitWaitPromises)) {
                exitWaitPromises.push(shutdown);
            }
        });

        getLivePreviewInterface().catch(console.error);
        if (!await waitForNodeReady(30000)) {
            updateState({status: "error", error: "Die Phoenix-Node-Laufzeit wurde nicht bereit."});
            return;
        }

        const root = ProjectManager.getProjectRoot(),
            rootPath = root && root.fullPath;
        if (!isPhoenixInternalProject(rootPath)) {
            try {
                await configureProject(toNativePath(rootPath));
            } catch (error) {
                reportError(error);
            }
        }
    });
});
