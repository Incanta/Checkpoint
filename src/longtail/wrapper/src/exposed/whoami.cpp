#include <string>

#include "../util/trpc-client.h"
#include "main.h"

Checkpoint::WhoamiResult* Checkpoint::Whoami(const char* serverId) {
  Checkpoint::WhoamiResult* result = new Checkpoint::WhoamiResult();

  json input = json::object(); // Empty input for user.me query

  json jsonResult = tRPCClient::Query(serverId, "user.me", input);

  if (jsonResult.contains("error")) {
    std::string error = jsonResult["error"];
    result->success = false;
    result->error = new char[error.length() + 1];
    strcpy(result->error, error.c_str());
    return result;
  }

  // tRPC returns the result directly, not wrapped in data object
  if (jsonResult.contains("result") && jsonResult["result"].contains("data")) {
    json data = jsonResult["result"]["data"];
    std::string id = data["id"];
    std::string email = data["email"];
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
