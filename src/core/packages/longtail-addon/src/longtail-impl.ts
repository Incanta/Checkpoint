import { LongtailBun } from "./longtail-bun";
import { LongtailKoffi } from "./longtail-koffi";

export function LongtailLib() {
  // return LongtailKoffi.get();
  return LongtailBun.lib();
}

export function LongtailClose(): void {
  LongtailBun.close();
}
