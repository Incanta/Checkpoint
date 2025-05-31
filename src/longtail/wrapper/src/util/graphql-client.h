#pragma once

#include <map>
#include <string>

#include "../util/json.hpp"

using json = nlohmann::json;

namespace GraphQLClient {

json Request(
    std::string serverId,
    const std::string& query,
    const json& variables);

}
