#include <string>

#include "../util/graphql-client.h"
#include "main.h"

Checkpoint::WhoamiResult* Checkpoint::Whoami(const char* serverId) {
  Checkpoint::WhoamiResult* result = new Checkpoint::WhoamiResult();

  std::string query = R"EOF(
    query {
      me {
        id
        email
      }
    }
  )EOF";

  json variables;

  json jsonResult = GraphQLClient::Request(serverId, query, variables);

  if (jsonResult.contains("error")) {
    std::string error = jsonResult["error"];
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  if (jsonResult.contains("data") && jsonResult["data"].contains("me")) {
    json me = jsonResult["data"]["me"];
    std::string id = me["id"];
    std::string email = me["email"];
    result->success = true;
    result->id = new char[id.length() + 1];
    strcpy(result->id, id.c_str());
    result->email = new char[email.length() + 1];
    strcpy(result->email, email.c_str());
    return result;
  } else {
    std::string error = "Invalid response format";
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }
}

void Checkpoint::FreeWhoami(Checkpoint::WhoamiResult* result) {
  if (result->id != nullptr) {
    delete[] result->id;
  }
  if (result->email != nullptr) {
    delete[] result->email;
  }
  if (result->error != nullptr) {
    delete[] result->error;
  }
  delete result;
}
