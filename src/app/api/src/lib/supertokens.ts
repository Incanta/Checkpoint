import * as Session from "supertokens-node/recipe/session"
import ThirdPartyEmailPassword from "supertokens-node/recipe/thirdpartyemailpassword"
import type { TypeInput } from "supertokens-node/types"

const websiteDomain =
  process.env.SUPERTOKENS_WEBSITE_DOMAIN;
const apiDomain = process.env.SUPERTOKENS_API_DOMAIN || websiteDomain;
const apiGatewayPath =
  process.env.SUPERTOKENS_API_GATEWAY_PATH || "/.redwood/functions";

export const config: TypeInput = {
  // The below options are ok here even if you're not running on top of AWS Lambda,
  // since Redwood internally translates Fastify request/response objects to and
  // from the AWS Lambda format.
  framework: "awsLambda",
  isInServerlessEnv: false,
  appInfo: {
    appName: process.env.SUPERTOKENS_APP_NAME,
    apiDomain,
    websiteDomain,
    apiGatewayPath,
    websiteBasePath: "/auth",
    apiBasePath: "/auth",
  },
  supertokens: {
    connectionURI: process.env.SUPERTOKENS_CONNECTION_URI,
    apiKey: process.env.SUPERTOKENS_API_KEY,
  },
  recipeList: [
    ThirdPartyEmailPassword.init(),
    Session.init({
      getTokenTransferMethod: () => {
        return "header"
      },
    }),
  ],
}
