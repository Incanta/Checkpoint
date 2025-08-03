#pragma once

#include <map>
#include <string>

#include "../util/json.hpp"

using json = nlohmann::json;

namespace tRPCClient {

json Query(
    std::string serverId,
    const std::string& procedure,
    const json& input);

json Mutation(
    std::string serverId,
    const std::string& procedure,
    const json& input);

}