import { dlopen, FFIType, suffix, type Library, type Symbols } from "bun:ffi";
import path from "path";
import os from "os";

export class LongtailBun {
  private static instance: LongtailBun;

  public lib: Library<any>["symbols"] | null;
  public close: Library<any>["close"] | null;

  private constructor() {
    this.lib = null;
    this.close = null;
  }

  public static get(): LongtailBun {
    if (!LongtailBun.instance) {
      LongtailBun.instance = new LongtailBun();
    }

    return LongtailBun.instance;
  }

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  public static lib() {
    let platform = "";
    switch (os.platform()) {
      case "win32": {
        platform = "win32_x64";
        break;
      }
      case "linux": {
        platform = "linux_x64";
        break;
      }
      case "darwin": {
        platform = "macos_x64";
        break;
      }
      default: {
        throw new Error("Unsupported OS");
      }
    }
    const libraryPath = path.join(
      __dirname,
      "..",
      "src",
      "longtail",
      platform,
      process.env.NODE_ENV === "DEBUG" ? "debug" : "release",
      `longtail_dylib.${suffix}`
    );

    const dloutput = dlopen(libraryPath, {
      /**
       * @param worker_count uint32_t
       * @param worker_priority int
       * @returns Longtail_JobAPI*
       */
      Longtail_CreateBikeshedJobAPI: {
        args: [FFIType.u32, FFIType.int],
        returns: FFIType.ptr,
      },

      /**
       * @returns Longtail_HashRegistryAPI*
       */
      Longtail_CreateFullHashRegistry: {
        args: [],
        returns: FFIType.ptr,
      },

      /**
       * @returns Longtail_CompressionRegistryAPI*
       */
      Longtail_CreateFullCompressionRegistry: {
        args: [],
        returns: FFIType.ptr,
      },

      /**
       * @param backing_block_store Longtail_BlockStoreAPI*
       * @param compression_registry Longtail_CompressionRegistryAPI*
       * @returns Longtail_BlockStoreAPI*
       */
      Longtail_CreateCompressBlockStoreAPI: {
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.ptr,
      },

      /**
       * @returns uint32_t
       */
      Longtail_GetBlake3HashType: {
        args: [],
        returns: FFIType.u32,
      },

      /**
       * @param
       * @param
       * @param
       * @returns int
       */
      Longtail_GetHashRegistry_GetHashAPI: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr],
        returns: FFIType.int,
      },

      /**
       * @param buffer const void*
       * @param size size_t
       * @param out_version_index Longtail_VersionIndex**
       */
      Longtail_ReadVersionIndexFromBuffer: {
        args: [FFIType.ptr, FFIType.u64_fast, FFIType.ptr],
        returns: FFIType.int,
      },

      /**
       * @param buffer const void*
       * @param size size_t
       * @param out_version_index Longtail_StoreIndex**
       */
      Longtail_ReadStoreIndexFromBuffer: {
        args: [FFIType.ptr, FFIType.u64_fast, FFIType.ptr],
        returns: FFIType.int,
      },

      /**
       * @param version_index const Longtail_VersionIndex*
       * @param out_buffer uint8_t**
       * @param out_size size_t*
       */
      Longtail_WriteVersionIndexToBuffer: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.int,
      },
    });

    LongtailBun.get().lib = dloutput.symbols;
    LongtailBun.get().close = dloutput.close;

    return dloutput.symbols;
  }

  public static close(): void {
    const instance = LongtailBun.get();

    if (instance.close !== null) {
      instance.close();
    }
  }
}
