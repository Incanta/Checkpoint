cmake_minimum_required(VERSION 3.15)
cmake_policy(SET CMP0091 NEW)
cmake_policy(SET CMP0042 NEW)

# Use embedded debug info (/Z7) to avoid PDB manager C1902 issues
if(POLICY CMP0141)
  cmake_policy(SET CMP0141 NEW)
  set(CMAKE_MSVC_DEBUG_INFORMATION_FORMAT "Embedded")
endif()

project(longtail_addon)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED True)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# --------------------------------------------------------------------------
# Node.js / node-addon-api setup
# --------------------------------------------------------------------------

include_directories(${CMAKE_JS_INC})

execute_process(
  COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
include_directories(${NODE_ADDON_API_DIR})

# --------------------------------------------------------------------------
# Longtail C library (built from source)
# --------------------------------------------------------------------------

add_subdirectory(
  "${CMAKE_CURRENT_SOURCE_DIR}/../library"
  "${CMAKE_CURRENT_BINARY_DIR}/longtail_library"
)

# --------------------------------------------------------------------------
# libcurl (fetched and built from source)
# --------------------------------------------------------------------------

include(FetchContent)
set(BUILD_CURL_EXE OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(HTTP_ONLY ON CACHE BOOL "" FORCE)

if(WIN32)
  set(CURL_USE_SCHANNEL ON CACHE BOOL "" FORCE)
  set(CURL_USE_OPENSSL OFF CACHE BOOL "" FORCE)
elseif(APPLE)
  set(CURL_USE_SECTRANSPORT ON CACHE BOOL "" FORCE)
  set(CURL_USE_OPENSSL OFF CACHE BOOL "" FORCE)
else()
  set(CURL_USE_OPENSSL ON CACHE BOOL "" FORCE)
  set(CURL_USE_SCHANNEL OFF CACHE BOOL "" FORCE)
endif()

FetchContent_Declare(
  curl
  GIT_REPOSITORY https://github.com/curl/curl.git
  GIT_TAG curl-8_5_0
)
FetchContent_MakeAvailable(curl)

# --------------------------------------------------------------------------
# Wrapper source files — compiled directly into the addon
# --------------------------------------------------------------------------

set(WRAPPER_DIR "${CMAKE_SOURCE_DIR}/../wrapper")

file(GLOB WRAPPER_SOURCES
  "${WRAPPER_DIR}/src/exposed/*.cpp"
  "${WRAPPER_DIR}/src/util/*.cpp"
)

# --------------------------------------------------------------------------
# Addon target
# --------------------------------------------------------------------------

add_library(${PROJECT_NAME} SHARED
  src/longtail-addon.cpp
  ${WRAPPER_SOURCES}
)

target_compile_definitions(${PROJECT_NAME} PRIVATE
  NAPI_VERSION=8
  NODE_ADDON_API_DISABLE_DEPRECATED
  CURL_STATICLIB
)

set_target_properties(${PROJECT_NAME} PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)

# --------------------------------------------------------------------------
# Include directories
# --------------------------------------------------------------------------

# Wrapper headers
target_include_directories(${PROJECT_NAME} PRIVATE
  "${WRAPPER_DIR}/src/exposed"
  "${WRAPPER_DIR}/src/util"
)

# Longtail C library headers are provided transitively by the longtail
# target (PUBLIC include dirs from add_subdirectory above).

# libcurl headers (from FetchContent)
target_include_directories(${PROJECT_NAME} PRIVATE
  "${curl_SOURCE_DIR}/include"
  "${curl_BINARY_DIR}/include/curl"
)

# --------------------------------------------------------------------------
# Link libraries
# --------------------------------------------------------------------------

target_link_libraries(${PROJECT_NAME}
  ${CMAKE_JS_LIB}
  longtail
  libcurl
)

if(WIN32)
  target_link_libraries(${PROJECT_NAME}
    ws2_32
    crypt32
    wldap32
    normaliz
    advapi32
    bcrypt
    delayimp
  )
elseif(APPLE)
  find_library(SECURITY_FW Security)
  find_library(COREFOUNDATION_FW CoreFoundation)
  find_library(SYSTEMCONFIGURATION_FW SystemConfiguration)
  target_link_libraries(${PROJECT_NAME}
    ${SECURITY_FW}
    ${COREFOUNDATION_FW}
    ${SYSTEMCONFIGURATION_FW}
  )
elseif(UNIX)
  find_package(OpenSSL REQUIRED)
  target_link_libraries(${PROJECT_NAME} OpenSSL::SSL OpenSSL::Crypto pthread dl)
endif()
