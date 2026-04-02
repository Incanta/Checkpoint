import config from "@incanta/config";

/**
 * Returns the effective filer URL based on whether stub mode is enabled.
 *
 * When `seaweedfs.stub.enabled` is true, returns the stub filer URL
 * (served by this Core Server itself at /filer).
 * Otherwise, returns the real SeaweedFS filer URL from config.
 */
export function getFilerUrl(): string {
  const useStub = config.get<boolean>("seaweedfs.stub.enabled");

  if (useStub) {
    return `http://${config.get<string>("seaweedfs.stub.external-url")}/filer`;
  }

  return `http${
    config.get<boolean>("seaweedfs.connection.filer.tls") ? "s" : ""
  }://${config.get<string>(
    "seaweedfs.connection.filer.host",
  )}:${config.get<number>("seaweedfs.connection.filer.port")}`;
}
