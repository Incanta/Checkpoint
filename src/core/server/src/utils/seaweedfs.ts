import config from "@incanta/config";

export function getSeaweedMasterUrl(): string {
  return `$http${
    config.get<boolean>("storage.seaweedfs.connection.master.tls") && "s"
  }://${config.get<string>(
    "storage.seaweedfs.connection.master.host",
  )}:${config.get<number>("storage.seaweedfs.connection.master.port")}`;
}
