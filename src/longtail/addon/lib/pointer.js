"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObjectPointer = exports.StringPointer = exports.NumberPointer = exports.VoidPointer = void 0;
class VoidPointer {
    pointer;
    constructor() {
        this.pointer = [null];
    }
    ptr() {
        return this.pointer;
    }
    deref() {
        return this.pointer[0];
    }
}
exports.VoidPointer = VoidPointer;
class NumberPointer {
    pointer;
    constructor() {
        this.pointer = [0];
    }
    ptr() {
        return this.pointer;
    }
    deref() {
        return this.pointer[0];
    }
}
exports.NumberPointer = NumberPointer;
class StringPointer {
    pointer;
    constructor(length) {
        this.pointer = ["\0".repeat(length)];
    }
    ptr() {
        return this.pointer;
    }
    deref() {
        return this.pointer[0];
    }
}
exports.StringPointer = StringPointer;
class ObjectPointer {
    pointer;
    constructor() {
        this.pointer = [{ dummy: 0 }];
    }
    valid() {
        return typeof this.pointer[0]["dummy"] === "undefined";
    }
    ptr() {
        return this.pointer;
    }
    deref() {
        return this.pointer[0];
    }
}
exports.ObjectPointer = ObjectPointer;
//# sourceMappingURL=pointer.js.map