cmake_minimum_required(VERSION 3.15)
project(LongtailWrapper)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED True)

include(FetchContent)
FetchContent_Declare(cpr GIT_REPOSITORY https://github.com/libcpr/cpr.git
                         GIT_TAG dd967cb48ea6bcbad9f1da5ada0db8ac0d532c06) # 1.11.2
FetchContent_MakeAvailable(cpr)

FetchContent_Declare(
  sqlite3
  URL https://sqlite.org/2025/sqlite-amalgamation-3490200.zip
  URL_HASH SHA3_256=fad307cde789046256b4960734d7fec6b31db7f5dc8525474484885faf82866c
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(sqlite3)

# Create SQLite library
add_library(sqlite3 STATIC
  ${sqlite3_SOURCE_DIR}/sqlite3.c
)
target_include_directories(sqlite3 PUBLIC ${sqlite3_SOURCE_DIR})
set(SQLite3_INCLUDE_DIRS ${sqlite3_SOURCE_DIR})
set(SQLite3_LIBRARIES sqlite3)

file(COPY Makefile DESTINATION ${CMAKE_CURRENT_BINARY_DIR})

file(GLOB SOURCES "src/*/*.cpp")

add_library(LongtailWrapper SHARED ${SOURCES})

target_include_directories(LongtailWrapper PRIVATE
  longtail/include/src
  longtail/include/lib
  ${SQLite3_INCLUDE_DIRS}
)

find_library(LongtailLibrary longtail PATHS longtail/debug/)

target_link_libraries(
  LongtailWrapper
  ${LongtailLibrary}
  cpr::cpr
  ${SQLite3_LIBRARIES}
)

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
