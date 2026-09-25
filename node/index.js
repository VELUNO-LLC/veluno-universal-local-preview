"use strict";

const {PreviewRuntimeManager} = require("./runtime-manager");

const CONNECTOR_ID = "veluno-universal-local-preview";
let connector = null;

const manager = new PreviewRuntimeManager({
    onState: function (state) {
        if (connector) {
            connector.triggerPeer("runtimeStatus", state);
        }
    }
});

async function inspectProject(options) {
    return manager.inspectProject(options.projectRoot);
}

async function validatePhp(options) {
    return manager.validatePhp(options.executable);
}

async function startPreview(options) {
    return manager.startPreview(options);
}

async function stopPreview() {
    return manager.stopPreview();
}

async function shutdown() {
    return manager.shutdown();
}

async function getState() {
    return manager.getState();
}

exports.inspectProject = inspectProject;
exports.validatePhp = validatePhp;
exports.startPreview = startPreview;
exports.stopPreview = stopPreview;
exports.shutdown = shutdown;
exports.getState = getState;

connector = global.createNodeConnector(CONNECTOR_ID, exports);

process.on("exit", function () {
    manager.forceStop();
});
