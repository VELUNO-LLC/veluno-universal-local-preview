"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {toNativePath} = require("../path-utils");

function adapter(platformPath) {
    return {
        getVirtualRoot: function () {
            return "/tauri/";
        },
        toPlatformPath: function (virtualPath) {
            assert.ok(virtualPath.startsWith("/tauri/"));
            return platformPath;
        }
    };
}

test("Phoenix macOS VFS paths use the official platform converter", function () {
    const expected = "/Volumes/VELUNO LLC/VELUNO/Webseite/veluno.co/";
    assert.equal(
        toNativePath("/tauri/Volumes/VELUNO LLC/VELUNO/Webseite/veluno.co/", adapter(expected)),
        expected
    );
});

test("Phoenix Windows VFS paths use the official platform converter", function () {
    const expected = "C:\\Users\\Sebastian\\Website\\veluno.co\\";
    assert.equal(
        toNativePath("/tauri/C:/Users/Sebastian/Website/veluno.co/", adapter(expected)),
        expected
    );
});

test("Phoenix Linux VFS paths use the official platform converter", function () {
    const expected = "/home/sebastian/Website/veluno.co/";
    assert.equal(
        toNativePath("/tauri/home/sebastian/Website/veluno.co/", adapter(expected)),
        expected
    );
});

test("already-native paths remain unchanged", function () {
    const nativePath = "/Volumes/VELUNO LLC/VELUNO/Webseite/veluno.co/";
    assert.equal(toNativePath(nativePath, adapter("unused")), nativePath);
});
