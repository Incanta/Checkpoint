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

# Longtail C library headers
target_include_directories(${PROJECT_NAME} PRIVATE
  "${WRAPPER_DIR}/longtail/include/src"
  "${WRAPPER_DIR}/longtail/include/lib"
)

# libcurl headers (from wrapper's CMake build — check msvc build first, then generic)
if(EXISTS "${WRAPPER_DIR}/build-msvc/_deps/curl-src/include")
  target_include_directories(${PROJECT_NAME} PRIVATE
    "${WRAPPER_DIR}/build-msvc/_deps/curl-src/include"
    "${WRAPPER_DIR}/build-msvc/_deps/curl-build/include/curl"
  )
elseif(EXISTS "${WRAPPER_DIR}/build/_deps/curl-src/include")
  target_include_directories(${PROJECT_NAME} PRIVATE
    "${WRAPPER_DIR}/build/_deps/curl-src/include"
    "${WRAPPER_DIR}/build/_deps/curl-build/include/curl"
  )
else()
  message(WARNING "libcurl headers not found — build the wrapper first")
endif()

# --------------------------------------------------------------------------
# Link static libraries
# --------------------------------------------------------------------------

target_link_libraries(${PROJECT_NAME} ${CMAKE_JS_LIB})

if(WIN32)
  set(LIB_DIR "${CMAKE_SOURCE_DIR}/libraries/windows")

  # Static longtail C library
  find_library(LONGTAIL_STATIC_LIB
    NAMES longtail liblongtail
    PATHS "${LIB_DIR}"
    NO_DEFAULT_PATH
  )
  if(LONGTAIL_STATIC_LIB)
    target_link_libraries(${PROJECT_NAME} ${LONGTAIL_STATIC_LIB})
    message(STATUS "Found longtail static lib: ${LONGTAIL_STATIC_LIB}")
  else()
    message(FATAL_ERROR "longtail static library not found in ${LIB_DIR}")
  endif()

  # Static libcurl
  find_library(CURL_STATIC_LIB
    NAMES libcurl-d libcurl curl
    PATHS "${LIB_DIR}"
    NO_DEFAULT_PATH
  )
  if(CURL_STATIC_LIB)
    target_link_libraries(${PROJECT_NAME} ${CURL_STATIC_LIB})
    message(STATUS "Found curl static lib: ${CURL_STATIC_LIB}")
  else()
    message(FATAL_ERROR "libcurl static library not found in ${LIB_DIR}")
  endif()

  # Windows system libraries required by libcurl (Schannel) and longtail
  target_link_libraries(${PROJECT_NAME}
    ws2_32
    crypt32
    wldap32
    normaliz
    advapi32
    bcrypt
    delayimp
  )

  target_compile_definitions(${PROJECT_NAME} PRIVATE
    CURL_STATICLIB
  )

elseif(APPLE)
  set(LIB_DIR "${CMAKE_SOURCE_DIR}/libraries/macos")

  find_library(LONGTAIL_STATIC_LIB NAMES longtail liblongtail PATHS "${LIB_DIR}" NO_DEFAULT_PATH)
  find_library(CURL_STATIC_LIB NAMES curl libcurl PATHS "${LIB_DIR}" NO_DEFAULT_PATH)

  if(LONGTAIL_STATIC_LIB)
    target_link_libraries(${PROJECT_NAME} ${LONGTAIL_STATIC_LIB})
  endif()
  if(CURL_STATIC_LIB)
    target_link_libraries(${PROJECT_NAME} ${CURL_STATIC_LIB})
  endif()

  target_compile_definitions(${PROJECT_NAME} PRIVATE CURL_STATICLIB)

elseif(UNIX)
  set(LIB_DIR "${CMAKE_SOURCE_DIR}/libraries/linux")

  find_library(LONGTAIL_STATIC_LIB NAMES longtail liblongtail PATHS "${LIB_DIR}" NO_DEFAULT_PATH)
  find_library(CURL_STATIC_LIB NAMES curl libcurl PATHS "${LIB_DIR}" NO_DEFAULT_PATH)

  if(LONGTAIL_STATIC_LIB)
    target_link_libraries(${PROJECT_NAME} ${LONGTAIL_STATIC_LIB})
  endif()
  if(CURL_STATIC_LIB)
    target_link_libraries(${PROJECT_NAME} ${CURL_STATIC_LIB})
  endif()

  target_link_libraries(${PROJECT_NAME} pthread dl)
  target_compile_definitions(${PROJECT_NAME} PRIVATE CURL_STATICLIB)
endif()
