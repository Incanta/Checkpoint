cmake_minimum_required(VERSION 3.15)
project(LongtailWrapper)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED True)

include(FetchContent)
FetchContent_Declare(cpr GIT_REPOSITORY https://github.com/libcpr/cpr.git
                         GIT_TAG dd967cb48ea6bcbad9f1da5ada0db8ac0d532c06) # 1.11.2
FetchContent_MakeAvailable(cpr)

file(COPY Makefile DESTINATION ${CMAKE_CURRENT_BINARY_DIR})

file(GLOB SOURCES "src/*/*.cpp")

add_library(LongtailWrapper SHARED ${SOURCES})

target_include_directories(LongtailWrapper PRIVATE longtail/include/src longtail/include/lib)

find_library(LongtailLibrary longtail PATHS longtail/win32_x64/debug/)

target_link_libraries(
  LongtailWrapper
  ${LongtailLibrary}
  cpr::cpr
)

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
install(DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/longtail/win32_x64/debug/
        DESTINATION ${CMAKE_INSTALL_PREFIX}
        FILES_MATCHING PATTERN "longtail.*")

# Install build outputs to core/libraries/
install(DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/Debug/
        DESTINATION ${CMAKE_INSTALL_PREFIX}
        FILES_MATCHING PATTERN "*.*")

# Alternative approach using file(COPY) if you want to execute during build rather than install
# add_custom_command(TARGET LongtailWrapper POST_BUILD
#   COMMAND ${CMAKE_COMMAND} -E copy_directory
#     ${CMAKE_CURRENT_SOURCE_DIR}/longtail/win32_x64/debug/
#     ${CMAKE_CURRENT_SOURCE_DIR}/../../core/libraries/
#   COMMAND ${CMAKE_COMMAND} -E copy_directory
#     ${CMAKE_CURRENT_BINARY_DIR}/Debug/
#     ${CMAKE_CURRENT_SOURCE_DIR}/../../core/libraries/
# )
