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

find_library(LongtailLibrary longtail PATHS longtail/win32_x64/debug/)

target_link_libraries(
  LongtailWrapper
  ${LongtailLibrary}
  cpr::cpr
  ${SQLite3_LIBRARIES}
)

# Generate migrations.h header file from SQL migration files
set(MIGRATIONS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/prisma/migrations")
set(MIGRATIONS_HEADER "${CMAKE_CURRENT_BINARY_DIR}/include/migrations.h")

# Create include directory in build dir
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/include")

# Debug output to confirm paths
message(STATUS "Migrations source dir: ${MIGRATIONS_DIR}")
message(STATUS "Migrations header output: ${MIGRATIONS_HEADER}")

# Custom command to generate the migrations.h file
add_custom_command(
  OUTPUT ${MIGRATIONS_HEADER}
  COMMAND ${CMAKE_COMMAND} -E echo "Running migration generation script..."
  COMMAND ${CMAKE_COMMAND}
    -DMIGRATIONS_DIR=${MIGRATIONS_DIR}
    -DMIGRATIONS_HEADER=${MIGRATIONS_HEADER}
    -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/GenerateMigrations.cmake"
  COMMENT "Generating migrations.h from SQL files"
  # Make it depend on all SQL files in the migrations directory
  DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/cmake/GenerateMigrations.cmake"
          "$<TARGET_PROPERTY:scan_migrations,MIGRATION_DEPENDENCIES>"
  VERBATIM
)

# Create a "dummy" custom target to scan for migration files
add_custom_target(scan_migrations
  COMMAND ${CMAKE_COMMAND} -E echo "Scanning for migration files..."
  COMMAND ${CMAKE_COMMAND}
    -DMIGRATIONS_DIR=${MIGRATIONS_DIR}
    -DTARGET=scan_migrations
    -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/ScanMigrations.cmake"
  COMMENT "Scanning for migration file changes"
)

# Make sure migrations are generated before building
add_custom_target(generate_migrations ALL DEPENDS ${MIGRATIONS_HEADER})
add_dependencies(generate_migrations scan_migrations)
add_dependencies(LongtailWrapper generate_migrations)

# Force migrations.h to be created during configure time for better IDE integration
execute_process(
  COMMAND ${CMAKE_COMMAND} -E echo "Initial generation of migrations.h"
  COMMAND ${CMAKE_COMMAND}
    -DMIGRATIONS_DIR=${MIGRATIONS_DIR}
    -DMIGRATIONS_HEADER=${MIGRATIONS_HEADER}
    -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/GenerateMigrations.cmake"
)

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
install(DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/longtail/win32_x64/debug/
        DESTINATION ${CMAKE_INSTALL_PREFIX}
        FILES_MATCHING PATTERN "longtail.*")

# Install build outputs to core/libraries/
install(DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/Debug/
        DESTINATION ${CMAKE_INSTALL_PREFIX}
        FILES_MATCHING PATTERN "*.*")
