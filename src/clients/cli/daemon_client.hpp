#pragma once

#include <curl/curl.h>

#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>

namespace checkpoint {

/**
 * DaemonClient communicates with the Checkpoint daemon's tRPC HTTP API.
 *
 * tRPC URL patterns (httpBatchLink):
 *   Query:    GET  <base>/<procedure.path>?batch=1&input={"0":{"json":<input>}}
 *   Mutation: POST <base>/<procedure.path>?batch=1  body: {"0":{"json":<input>}}
 *
 * The daemon uses superjson as the transformer. Responses are wrapped in:
 *   [{"result": {"data": {"json": <actual data>, "meta": {...}}}}]
 *
 * superjson encodes non-JSON types (Date, Map, Set, etc.) via a "meta" field.
 * For this client, Date values appear as ISO 8601 strings in the "json" payload
 * which is directly usable in C++, so we only need to handle meta for Date
 * inputs when the daemon expects z.date() parameters.
 */
class DaemonClient {
 public:
  explicit DaemonClient(const std::string& baseUrl)
      : baseUrl_(baseUrl) {
    curl_global_init(CURL_GLOBAL_DEFAULT);
  }

  ~DaemonClient() {
    curl_global_cleanup();
  }

  // Perform a tRPC query (GET request, batch format)
  nlohmann::json query(const std::string& procedure, const nlohmann::json& input = nullptr) const {
    std::string url = baseUrl_ + "/" + procedure + "?batch=1";
    if (!input.is_null()) {
      // Batch format: {"0": {"json": <input>, "meta": {...}}}
      nlohmann::json batchInput;
      batchInput["0"] = buildSuperJsonEnvelope(input);
      std::string inputStr = batchInput.dump();
      char* encoded = curl_easy_escape(nullptr, inputStr.c_str(), static_cast<int>(inputStr.size()));
      if (encoded) {
        url += "&input=" + std::string(encoded);
        curl_free(encoded);
      }
    } else {
      // No input — still batch format
      nlohmann::json batchInput;
      batchInput["0"] = nlohmann::json::object({{"json", nullptr}});
      std::string inputStr = batchInput.dump();
      char* encoded = curl_easy_escape(nullptr, inputStr.c_str(), static_cast<int>(inputStr.size()));
      if (encoded) {
        url += "&input=" + std::string(encoded);
        curl_free(encoded);
      }
    }
    return doGet(url);
  }

  // Perform a tRPC mutation (POST request, batch format)
  nlohmann::json mutate(const std::string& procedure, const nlohmann::json& input) const {
    std::string url = baseUrl_ + "/" + procedure + "?batch=1";
    // Batch format body: {"0": {"json": <input>, "meta": {...}}}
    nlohmann::json batchInput;
    batchInput["0"] = buildSuperJsonEnvelope(input);
    return doPost(url, batchInput.dump());
  }

 private:
  std::string baseUrl_;

  /**
   * Build a superjson envelope: {"json": <data>, "meta": {"values": {...}}}
   * Scans the input for ISO 8601 date strings and marks them in meta.values
   * so the daemon's superjson deserializer can reconstruct Date objects.
   */
  static nlohmann::json buildSuperJsonEnvelope(const nlohmann::json& input) {
    nlohmann::json envelope;
    envelope["json"] = input;

    // Scan for date-like string values and build meta.values
    nlohmann::json metaValues = nlohmann::json::object();
    scanForDates(input, "", metaValues);

    if (!metaValues.empty()) {
      envelope["meta"] = nlohmann::json::object({{"values", metaValues}});
    }

    return envelope;
  }

  /**
   * Recursively scan a JSON value for ISO 8601 date strings.
   * Adds entries to metaValues like {"path.to.field": ["Date"]}.
   */
  static void scanForDates(const nlohmann::json& value, const std::string& path, nlohmann::json& metaValues) {
    if (value.is_string()) {
      const auto& str = value.get_ref<const std::string&>();
      if (isIso8601Date(str)) {
        metaValues[path] = nlohmann::json::array({"Date"});
      }
    } else if (value.is_object()) {
      for (auto& [key, val] : value.items()) {
        std::string childPath = path.empty() ? key : (path + "." + key);
        scanForDates(val, childPath, metaValues);
      }
    } else if (value.is_array()) {
      for (size_t i = 0; i < value.size(); i++) {
        std::string childPath = path.empty() ? std::to_string(i) : (path + "." + std::to_string(i));
        scanForDates(value[i], childPath, metaValues);
      }
    }
  }

  /**
   * Check if a string looks like an ISO 8601 date (e.g. "2026-03-09T12:00:00.000Z").
   * Simple heuristic: matches YYYY-MM-DDTHH:MM:SS pattern.
   */
  static bool isIso8601Date(const std::string& str) {
    // Minimum: "YYYY-MM-DDTHH:MM:SSZ" = 20 chars
    if (str.size() < 20 || str.size() > 30) return false;
    if (str[4] != '-' || str[7] != '-' || str[10] != 'T') return false;
    if (str[13] != ':' || str[16] != ':') return false;
    // Check digits in expected positions
    for (int i : {0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18}) {
      if (str[i] < '0' || str[i] > '9') return false;
    }
    return true;
  }

  static size_t writeCallback(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* response = static_cast<std::string*>(userdata);
    response->append(ptr, size * nmemb);
    return size * nmemb;
  }

  nlohmann::json doGet(const std::string& url) const {
    CURL* curl = curl_easy_init();
    if (!curl) {
      throw std::runtime_error("Failed to initialize curl");
    }

    std::string response;
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 5L);

    CURLcode res = curl_easy_perform(curl);
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) {
      throw std::runtime_error(
          "Failed to connect to daemon: " + std::string(curl_easy_strerror(res)) +
          "\nIs the Checkpoint daemon running? Start it with: cd src/core && yarn daemon");
    }

    return parseResponse(response, httpCode);
  }

  nlohmann::json doPost(const std::string& url, const std::string& body) const {
    CURL* curl = curl_easy_init();
    if (!curl) {
      throw std::runtime_error("Failed to initialize curl");
    }

    std::string response;
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    // Disable Expect: 100-continue to avoid body truncation issues with
    // Node.js HTTP servers that may not handle 100 Continue reliably.
    headers = curl_slist_append(headers, "Expect:");

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
    // Explicitly set body size instead of relying on strlen()
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE_LARGE,
                     static_cast<curl_off_t>(body.size()));
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 120L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 5L);

    CURLcode res = curl_easy_perform(curl);
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) {
      throw std::runtime_error(
          "Failed to connect to daemon: " + std::string(curl_easy_strerror(res)) +
          "\nIs the Checkpoint daemon running? Start it with: cd src/core && yarn daemon");
    }

    return parseResponse(response, httpCode);
  }

  static nlohmann::json parseResponse(const std::string& response, long httpCode) {
    if (response.empty()) {
      if (httpCode >= 200 && httpCode < 300) {
        return nullptr;
      }
      throw std::runtime_error("Daemon returned HTTP " + std::to_string(httpCode) + " with empty body");
    }

    nlohmann::json parsed;
    try {
      parsed = nlohmann::json::parse(response);
    } catch (const nlohmann::json::exception& e) {
      // Include response preview for debugging truncation issues
      std::string preview = response.substr(0, 200);
      throw std::runtime_error("Invalid JSON response from daemon (HTTP " +
                               std::to_string(httpCode) + ", " +
                               std::to_string(response.size()) + " bytes): " +
                               std::string(e.what()) + "\nResponse preview: " + preview);
    }

    // httpBatchLink wraps responses in an array: [{result: ...}]
    // Unwrap the first element if it's a batch response
    if (parsed.is_array()) {
      if (parsed.empty()) {
        return nullptr;
      }
      parsed = parsed[0];
    }

    // tRPC error response format: {"error": {"json": {"message": "..."}}}
    if (parsed.contains("error")) {
      auto& err = parsed["error"];
      std::string message = "Daemon error";
      if (err.contains("json") && err["json"].is_object()) {
        if (err["json"].contains("message") && err["json"]["message"].is_string()) {
          message = err["json"]["message"].get<std::string>();
        }
      } else if (err.contains("message") && err["message"].is_string()) {
        message = err["message"].get<std::string>();
      }
      // Include HTTP status for diagnostics (e.g. 400 = parse error, 500 = server error)
      if (httpCode >= 400) {
        message += " (HTTP " + std::to_string(httpCode) + ")";
      }
      throw std::runtime_error(message);
    }

    // tRPC batch response: {"result": {"data": {"json": <data>, "meta": {...}}}}
    // We extract "json" and ignore "meta" since Date values are already
    // ISO 8601 strings which are directly usable in C++.
    if (parsed.contains("result")) {
      auto& result = parsed["result"];
      if (result.contains("data")) {
        auto& data = result["data"];
        if (data.contains("json")) {
          return data["json"];
        }
        return data;
      }
      return result;
    }

    return parsed;
  }
};

}  // namespace checkpoint
