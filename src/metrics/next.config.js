/** @type {import('next').NextConfig} */
const config = {
  output: "standalone",
  // The Prisma client (generated into src/generated/prisma) and its query
  // engine must not be bundled; trace them as external for standalone builds.
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
};

export default config;
