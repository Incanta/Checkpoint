import { authDecoder as supertokensAuthDecoder } from "@redwoodjs/auth-supertokens-api";
import { createGraphQLHandler } from "@redwoodjs/graphql-server";

import directives from "src/directives/**/*.{js,ts}";
import sdls from "src/graphql/**/*.sdl.{js,ts}";
import services from "src/services/**/*.{js,ts}";

import { getCurrentUser, authDecoder as apiTokenAuthDecoder } from "src/lib/auth";
import { db } from "src/lib/db";
import { logger } from "src/lib/logger";

export const handler = createGraphQLHandler({
  authDecoder: [supertokensAuthDecoder, apiTokenAuthDecoder],
  getCurrentUser,
  loggerConfig: { logger, options: {} },
  directives,
  sdls,
  services,
  onException: () => {
    // Disconnect from your database with an unhandled exception.
    db.$disconnect();
  },
});
