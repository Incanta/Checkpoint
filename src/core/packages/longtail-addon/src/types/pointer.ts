export class VoidPointer {
  private pointer: any[];

  public constructor() {
    this.pointer = [null];
  }

  public ptr(): any {
    return this.pointer;
  }

  public deref(): any {
    return this.pointer[0];
  }
}

export class NumberPointer {
  private pointer: number[];

  public constructor() {
    this.pointer = [0];
  }

  public ptr(): number[] {
    return this.pointer;
  }

  public deref(): number {
    return this.pointer[0];
  }
}

export class BigIntPointer {
  private pointer: bigint[];

  public constructor() {
    this.pointer = [BigInt(0)];
  }

  public ptr(): bigint[] {
    return this.pointer;
  }

  public deref(): bigint {
    return this.pointer[0];
  }
}

export class BufferPointer {
  private pointer: Uint8Array[];

  public constructor(length: number) {
    this.pointer = [new Uint8Array(length)];
  }

  public ptr(): Uint8Array[] {
    return this.pointer;
  }

  public deref(): Uint8Array {
    return this.pointer[0];
  }
}

export class StringPointer {
  private pointer: string[];

  public constructor(length: number) {
    this.pointer = ["\0".repeat(length)];
  }

  public ptr(): string[] {
    return this.pointer;
  }

  public deref(): string {
    return this.pointer[0];
  }
}

export class ObjectPointer {
  private pointer: BigUint64Array;

  public constructor() {
    this.pointer = new BigUint64Array(1);
    this.pointer[0] = 0n;
  }

  public valid(): boolean {
    return this.pointer[0] !== 0n;
  }

  public asOutput(): any {
    return this.pointer;
  }

  public asInput(): any {
    return this.pointer[0];
  }
}
