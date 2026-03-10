cmake_minimum_required(VERSION 3.15)
project(checkpoint_cli LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Find dependencies
find_package(CURL REQUIRED)
find_package(nlohmann_json REQUIRED)

# Source files
set(CLI_SOURCES main.cpp)

# Main executable: checkpoint
add_executable(checkpoint ${CLI_SOURCES})
target_include_directories(checkpoint PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(checkpoint PRIVATE CURL::libcurl nlohmann_json::nlohmann_json)

# Alias executable: chk
add_executable(chk ${CLI_SOURCES})
target_include_directories(chk PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(chk PRIVATE CURL::libcurl nlohmann_json::nlohmann_json)

# Platform-specific settings
if(WIN32)
  target_link_libraries(checkpoint PRIVATE ws2_32 crypt32)
  target_link_libraries(chk PRIVATE ws2_32 crypt32)
elseif(APPLE)
  find_library(SECURITY_FRAMEWORK Security)
  find_library(COREFOUNDATION_FRAMEWORK CoreFoundation)
  if(SECURITY_FRAMEWORK AND COREFOUNDATION_FRAMEWORK)
    target_link_libraries(checkpoint PRIVATE ${SECURITY_FRAMEWORK} ${COREFOUNDATION_FRAMEWORK})
    target_link_libraries(chk PRIVATE ${SECURITY_FRAMEWORK} ${COREFOUNDATION_FRAMEWORK})
  endif()
elseif(UNIX)
  find_package(Threads REQUIRED)
  target_link_libraries(checkpoint PRIVATE Threads::Threads)
  target_link_libraries(chk PRIVATE Threads::Threads)
endif()

# Install targets
install(TARGETS checkpoint chk RUNTIME DESTINATION bin)
