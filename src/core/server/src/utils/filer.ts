import config from "@incanta/config";

/**
 * Returns the effective filer URL based on whether stub mode is enabled.
 */
export function getFilerUrl(internal: boolean): string {
  return `http${
    config.get<boolean>(
      `seaweedfs.connection.filer.${internal ? "internal" : "external"}.tls`,
    )
      ? "s"
      : ""
  }://${config.get<string>(
    `seaweedfs.connection.filer.${internal ? "internal" : "external"}.host`,
  )}:${config.get<number>(
    `seaweedfs.connection.filer.${internal ? "internal" : "external"}.port`,
  )}${config.get<string>(
    `seaweedfs.connection.filer.${internal ? "internal" : "external"}.path`,
  )}`;
}
