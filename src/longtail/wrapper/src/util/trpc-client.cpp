#include "trpc-client.h"

#include <cpr/cpr.h>

#include "../exposed/types.h"
#include "config.h"

namespace tRPCClient {

static json makeRequest(
    std::string serverId,
    const std::string& procedure,
    const json& input,
    bool isMutation) {
  Checkpoint::Server serverConfig = CheckpointConfig::GetServerConfig(serverId);
  if (serverConfig.id.empty()) {
    json result = {
        {"error", "Server id '" + serverId + "' not configured"}};
    return result;
  }

  if (serverConfig.accessToken.empty()) {
    json result = {
        {"error", "Not logged in"}};
    return result;
  }

  // Build tRPC URL path
  std::string url = serverConfig.baseUrl + "/api/trpc/" + procedure;
  if (!isMutation) {
    // For queries, add input as URL parameters
    if (!input.empty()) {
      url += "?input=" + cpr::util::urlEncode(input.dump());
    }
  }

  cpr::Response r;
  if (isMutation) {
    // For mutations, send POST with input in body
    r = cpr::Post(
        cpr::Url{url},
        cpr::Bearer{serverConfig.accessToken},
        cpr::Header{{"Content-Type", "application/json"}},
        cpr::Header{{"auth-provider", "auth0"}},
        cpr::Body{input.dump()});
  } else {
    // For queries, send GET
    r = cpr::Get(
        cpr::Url{url},
        cpr::Bearer{serverConfig.accessToken},
        cpr::Header{{"auth-provider", "auth0"}});
  }

  if (r.status_code != 200) {
    json result = {
        {"error", r.status_line},
    };
    return result;
  } else {
    json result = json::parse(r.text);
    return result;
  }
}

json Query(
    std::string serverId,
    const std::string& procedure,
    const json& input) {
  return makeRequest(serverId, procedure, input, false);
}

json Mutation(
    std::string serverId,
    const std::string& procedure,
    const json& input) {
  return makeRequest(serverId, procedure, input, true);
}

}