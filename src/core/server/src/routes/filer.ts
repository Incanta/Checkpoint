import config from "@incanta/config";

export function routeFiler() {
  return {
    "/filer-url": {
      GET: async (request: Request) => {
        const filerUrl = `http${
          config.get<boolean>("seaweedfs.connection.filer.tls") ? "s" : ""
        }://${config.get<string>(
          "seaweedfs.connection.filer.host",
        )}:${config.get<string>("seaweedfs.connection.filer.port")}`;

        return new Response(filerUrl, { status: 200 });
      },
    },
  };
}
