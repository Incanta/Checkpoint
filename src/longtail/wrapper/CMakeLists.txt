cmake_minimum_required(VERSION 3.15)
project(LongtailWrapper)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED True)

# Fetch and build curl
include(FetchContent)
set(BUILD_CURL_EXE OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(CURL_USE_SCHANNEL ON CACHE BOOL "" FORCE)  # Use Windows native SSL
set(CURL_USE_OPENSSL OFF CACHE BOOL "" FORCE)
set(HTTP_ONLY ON CACHE BOOL "" FORCE)  # We only need HTTP
FetchContent_Declare(
  curl
  GIT_REPOSITORY https://github.com/curl/curl.git
  GIT_TAG curl-8_5_0
)
FetchContent_MakeAvailable(curl)

file(COPY Makefile DESTINATION ${CMAKE_CURRENT_BINARY_DIR})

file(GLOB SOURCES "src/*/*.cpp")

add_library(LongtailWrapper SHARED ${SOURCES})

target_include_directories(LongtailWrapper PRIVATE
  longtail/include/src
  longtail/include/lib
)

find_library(LongtailLibrary
  longtail
  PATHS ${CMAKE_CURRENT_SOURCE_DIR}/longtail/debug/)

target_link_libraries(
  LongtailWrapper
  ${LongtailLibrary}
  libcurl
)

target_include_directories(LongtailWrapper PRIVATE ${curl_SOURCE_DIR}/include ${curl_BINARY_DIR}/include/curl)

# Create include directory in build dir
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/include")

# Add the generated header directory to include paths
target_include_directories(LongtailWrapper PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/include")

# Set a default install prefix to the project root if not specified
if(CMAKE_INSTALL_PREFIX_INITIALIZED_TO_DEFAULT)
  set(CMAKE_INSTALL_PREFIX "${CMAKE_CURRENT_SOURCE_DIR}/../../../core/libraries/" CACHE PATH "Installation prefix" FORCE)
endif()

# Install targets with runtime dependencies
# install(TARGETS LongtailWrapper
#   RUNTIME DESTINATION bin
#   LIBRARY DESTINATION lib
#   ARCHIVE DESTINATION lib
# )

# Install the longtail library files to core/libraries/
install(DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/longtail/debug/
        DESTINATION ${CMAKE_INSTALL_PREFIX}
        FILES_MATCHING PATTERN "longtail.*")

# Install build outputs to core/libraries/
install(DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/Debug/
        DESTINATION ${CMAKE_INSTALL_PREFIX}
        FILES_MATCHING PATTERN "*.*")
