#include "graphql-client.h"

#include <cpr/cpr.h>

#include "config.h"

json GraphQLClient::Request(
    const std::string& query,
    const json& variables) {
  if (CheckpointConfig::GetAuthToken().length() == 0) {
    json result = {
        {"error", "Not logged in"}};
    return result;
  }

  json payload = {
      {"query", query},
      {"variables", variables}};

  cpr::Response r = cpr::Post(
      cpr::Url{CheckpointConfig::GetGraphQLUrl()},
      cpr::Bearer{CheckpointConfig::GetAuthToken()},
      cpr::Header{{"Content-Type", "application/json"}},
      cpr::Header{{"auth-provider", "auth0"}},
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
