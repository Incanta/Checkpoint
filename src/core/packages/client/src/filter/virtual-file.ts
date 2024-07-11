export const VirtualFileVersion = 1;

export interface VirtualFile {
  specVersion: number;
  contents: string;
  sizeBytes: number;
}

// version https://git-lfs.github.com/spec/v1
// oid sha256:01bdef64e21fc3a88aa8256f53ac97a564f907c564a39d63e97223f36c7c7af9
// size 3656

export function StringifyVirtualFile(vf: VirtualFile): string {
  const lines: string[] = [];

  // NOTE: new variables should always be appended for better git
  // diffing. Avoid renaming variables if possible.
  lines.push(`version https://checkpointvcs.com/spec/v${vf.specVersion}`);
  lines.push(`oid ${vf.contents}`);
  lines.push(`size ${vf.sizeBytes}`);

  return lines.join("\n");
}

export function ParseVirtualFile(ini: string): VirtualFile {
  const lines = ini.split("\n");

  const [, versionStr] = lines[0].split(" ");
  const version = parseInt(versionStr, 10);
  // TODO: figure out how version migration works

  const oidTokens = lines[1].split(" ");

  const [, sizeStr] = lines[2].split(" ");
  const sizeBytes = parseInt(sizeStr, 10);

  const vf: VirtualFile = {
    specVersion: VirtualFileVersion,
    contents: oidTokens.slice(1).join(" "),
    sizeBytes,
  };

  return vf;
}
