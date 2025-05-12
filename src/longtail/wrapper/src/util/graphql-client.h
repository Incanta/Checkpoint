#pragma once

#include <map>
#include <string>

#include "../util/json.hpp"

using json = nlohmann::json;

namespace GraphQLClient {

json Request(
    const std::string& query,
    const json& variables);

}
