import { type ServerInterface } from "./server-interface";
import { Longtail } from "../longtail";
import { ObjectPointer } from "../types/pointer";
import { StoreIndexPointer } from "../types/store-index";
import { VersionIndexPointer } from "../types/version-index";

export async function createRepo(server: ServerInterface) {
  const numWorkerCount = 1; // TODO do we want to expose this or read the num processors?

  const longtail = Longtail.get();

  const jobs = longtail.CreateBikeshedJobAPI(numWorkerCount, 0);

  const hashRegistry = longtail.CreateFullHashRegistry();
  const hashIdentifier = longtail.GetBlake3HashType();

  const hashApiPointer = new ObjectPointer();
  longtail.HashRegistry_GetHashAPI(
    hashRegistry,
    hashIdentifier,
    hashApiPointer.ptr()
  );

  const versionIndex = new VersionIndexPointer();

  longtail.CreateVersionIndex(
    server.getStorageApi().get(),
    hashApiPointer.deref(),
    null,
    jobs,
    null,
    null,
    null,
    "",
    null,
    null,
    32768, // this is the default chunk size for golongtail 🤷
    0,
    versionIndex.ptr()
  );

  const storeIndex = new StoreIndexPointer();

  longtail.CreateStoreIndex(null, 0, null, null, null, 0, 0, storeIndex.ptr());

  await server.writeVersionIndex(versionIndex, "0");
  await server.writeStoreIndex(storeIndex, "0");
}
