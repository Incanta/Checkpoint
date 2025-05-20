# This script collects all SQL files in the migrations directory
# and sets them as dependencies for the target

# Scan for migration directories
file(GLOB_RECURSE SQL_FILES "${MIGRATIONS_DIR}/**/*.sql")

if(SQL_FILES)
  message(STATUS "Found ${CMAKE_LIST_LENGTH} SQL migration files")
  foreach(SQL_FILE ${SQL_FILES})
    message(STATUS "  Found migration file: ${SQL_FILE}")
  endforeach()
else()
  message(STATUS "No SQL migration files found in ${MIGRATIONS_DIR}")
endif()

# Set the property on the target with the list of files
set_property(
  TARGET ${TARGET}
  PROPERTY MIGRATION_DEPENDENCIES
  ${SQL_FILES}
)
