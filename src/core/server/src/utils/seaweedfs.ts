import config from "@incanta/config";

export function getSeaweedMasterUrl(): string {
  return `$http${
    config.get<boolean>("seaweedfs.connection.master.tls") && "s"
  }://${config.get<string>(
    "seaweedfs.connection.master.host"
  )}:${config.get<number>("seaweedfs.connection.master.port")}`;
}
