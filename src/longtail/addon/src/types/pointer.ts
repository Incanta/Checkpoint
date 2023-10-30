export class VoidPointer {
  private pointer: any[];

  constructor() {
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

  constructor() {
    this.pointer = [0];
  }

  public ptr(): number[] {
    return this.pointer;
  }

  public deref(): number {
    return this.pointer[0];
  }
}

export class StringPointer {
  private pointer: string[];

  constructor(length: number) {
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
  private pointer: any[];

  constructor() {
    this.pointer = [{ dummy: 0 }];
  }

  public valid(): boolean {
    return typeof this.pointer[0]["dummy"] === "undefined";
  }

  public ptr(): any[] {
    return this.pointer;
  }

  public deref(): any {
    return this.pointer[0];
  }
}
