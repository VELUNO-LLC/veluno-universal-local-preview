(function (factory) {
    "use strict";

    if (typeof define === "function" && define.amd) {
        define(factory);
    } else if (typeof module === "object" && module.exports) {
        module.exports = factory();
    }
}(function () {
    "use strict";

    function toNativePath(inputPath, adapter) {
        if (!inputPath || !adapter || typeof adapter.getVirtualRoot !== "function") {
            return inputPath || "";
        }

        const virtualRoot = adapter.getVirtualRoot();
        if (!virtualRoot || !inputPath.startsWith(virtualRoot)) {
            return inputPath;
        }
        if (typeof adapter.toPlatformPath !== "function") {
            throw new Error("Phoenix kann den virtuellen Projektpfad nicht in einen Systempfad umwandeln.");
        }
        return adapter.toPlatformPath(inputPath);
    }

    return {
        toNativePath: toNativePath
    };
}));
