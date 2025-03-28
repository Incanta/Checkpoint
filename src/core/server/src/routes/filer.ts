import config from "@incanta/config";
import type { Endpoint } from ".";

export function routeFiler(): Record<string, Endpoint> {
  return {
    "/filer-url": {
      GET: async (request: Request): Promise<typeof Response> => {
        const filerUrl = `http${
          config.get<boolean>("seaweedfs.connection.filer.tls") ? "s" : ""
        }://${config.get<string>(
          "seaweedfs.connection.filer.host"
        )}:${config.get<string>("seaweedfs.connection.filer.port")}`;

        return new Response(filerUrl, { status: 200 });
      },
    },
  };
}
