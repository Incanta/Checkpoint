#include "graphql-client.h"

#include <cpr/cpr.h>

#include "../exposed/types.h"
#include "config.h"

json GraphQLClient::Request(
    std::string serverId,
    const std::string& query,
    const json& variables) {
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

  json payload = {
      {"query", query},
      {"variables", variables}};

  cpr::Response r = cpr::Post(
      cpr::Url{serverConfig.graphqlUrl},
      cpr::Bearer{serverConfig.accessToken},
      cpr::Header{{"Content-Type", "application/json"}},
      cpr::Header{{"auth-provider", "api-token"}},
      cpr::Body{payload.dump()});

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
