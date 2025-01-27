import { decode, encode } from "koffi";
import { ObjectPointer } from "./pointer";
import { decodeHash } from "../util/decode";
import { LongtailKoffi } from "../longtail-koffi";

export interface FileInfos {
  count: number;
  sizes: bigint[];
  permissions: number[];
  paths: string[];
}

interface Longtail_FileInfos {
  m_Count: number;
  m_PathDataSize: number;
  m_Sizes: bigint[];
  m_PathStartOffsets: number[];
  m_Permissions: number[];
  m_PathData: string;
}

export function EncodeFileInfos(infos: FileInfos): ObjectPointer {
  const pathOffsets: number[] = [];
  let pathData: string = "";
  for (const p of infos.paths) {
    pathOffsets.push(pathData.length);
    pathData += p;
  }

  const preppedInfos: Longtail_FileInfos = {
    m_Count: infos.count,
    m_Sizes: infos.sizes,
    m_Permissions: infos.permissions,
    m_PathStartOffsets: pathOffsets,
    m_PathData: pathData,
    m_PathDataSize: pathData.length,
  };

  const obj = new ObjectPointer();
  encode(obj.asInput(), LongtailKoffi.get().FileInfos, preppedInfos);

  return obj;
}
