import { StorageApi } from "./storage-api";
// import koffi from "koffi";

const api = StorageApi.CreateFSStorageAPI();

const openFileResult = api.OpenReadFile("C:\\temp\\test.txt");

if (openFileResult.error) {
  throw new Error(`OpenReadFile failed with error ${openFileResult.error}`);
}

const sizeResult = api.GetSize(openFileResult.file);

if (sizeResult.error) {
  throw new Error(`GetSize failed with error ${sizeResult.error}`);
}

console.log(`size: ${sizeResult.size}`);

const readResult = api.Read(openFileResult.file, 0, sizeResult.size);

if (readResult.error) {
  throw new Error(`Read failed with error ${readResult.error}`);
}

console.log(`read: ${readResult.contents}`);
