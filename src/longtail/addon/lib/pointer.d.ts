export declare class VoidPointer {
    private pointer;
    constructor();
    ptr(): any;
    deref(): any;
}
export declare class NumberPointer {
    private pointer;
    constructor();
    ptr(): number[];
    deref(): number;
}
export declare class StringPointer {
    private pointer;
    constructor(length: number);
    ptr(): string[];
    deref(): string;
}
export declare class ObjectPointer {
    private pointer;
    constructor();
    valid(): boolean;
    ptr(): any[];
    deref(): any;
}
//# sourceMappingURL=pointer.d.ts.map