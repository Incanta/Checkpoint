# This script generates a C++ header with SQL migration contents as string constants
message(STATUS "Generating migrations.h from ${MIGRATIONS_DIR}")

# Check if the migrations directory exists
if(NOT EXISTS "${MIGRATIONS_DIR}")
  message(WARNING "Migrations directory not found: ${MIGRATIONS_DIR}")
  # Create a minimal header file
  file(WRITE "${MIGRATIONS_HEADER}" "#ifndef MIGRATIONS_H\n#define MIGRATIONS_H\n\n#include <string>\n#include <vector>\n\nnamespace Migrations {\n\nstatic const std::vector< std::pair<std::string, std::string> > migrations = {};\n\n// Get SQL content for a migration\ninline const std::string& getMigration(const std::string& name) {\n  static const std::string empty = \"\";\n  auto it = migrations.find(name);\n  return it != migrations.end() ? it->second : empty;\n}\n\n} // namespace Migrations\n\n#endif // MIGRATIONS_H\n")
  return()
endif()

# Function to sanitize a string to use as a C++ identifier
function(sanitize_identifier input_string output_var)
  # Replace non-alphanumeric characters with underscores
  string(REGEX REPLACE "[^a-zA-Z0-9]" "_" sanitized "${input_string}")

  # Ensure it starts with a letter or underscore
  string(REGEX REPLACE "^([0-9])" "_\\1" sanitized "${sanitized}")

  set(${output_var} "${sanitized}" PARENT_SCOPE)
endfunction()

# Start the header file with include guards and basic structure
file(WRITE "${MIGRATIONS_HEADER}" "#ifndef MIGRATIONS_H\n#define MIGRATIONS_H\n\n#include <string>\n#include <vector>\n\nnamespace Migrations {\n\n")

# Write file generation timestamp comment
string(TIMESTAMP TIMESTAMP "%Y-%m-%d %H:%M:%S")
file(APPEND "${MIGRATIONS_HEADER}" "// Auto-generated on ${TIMESTAMP}\n// DO NOT EDIT MANUALLY\n\n")

# Write a vector declaration to store all migrations
file(APPEND "${MIGRATIONS_HEADER}" "// Vector of migration names to their SQL content\nstatic const std::vector< std::pair<std::string, std::string> > migrations = {\n")

# Keep track if we've added any migrations
set(FOUND_MIGRATIONS FALSE)

# Scan for migration directories, sort by ascending name
file(GLOB MIGRATION_DIRS "${MIGRATIONS_DIR}/*")
list(SORT MIGRATION_DIRS)

# Process each migration directory
foreach(DIR ${MIGRATION_DIRS})
  if(IS_DIRECTORY "${DIR}")
    # Get the directory name (migration name)
    get_filename_component(MIGRATION_NAME "${DIR}" NAME)
    message(STATUS "Processing migration: ${MIGRATION_NAME}")

    # Get the SQL file(s) in this migration directory
    file(GLOB SQL_FILES "${DIR}/*.sql")

    foreach(SQL_FILE ${SQL_FILES})
      # Get filename without extension for the variable name
      get_filename_component(FILE_NAME "${SQL_FILE}" NAME)
      message(STATUS "  Processing SQL file: ${FILE_NAME}")

      # Create a unique variable name combining migration and file name
      set(VAR_NAME "${MIGRATION_NAME}")
      sanitize_identifier("${VAR_NAME}" SAFE_VAR_NAME)

      # Read the SQL file content
      file(READ "${SQL_FILE}" SQL_CONTENT)

      # Escape quotes and other special characters for C++ string
      string(REPLACE "\\" "\\\\" SQL_CONTENT "${SQL_CONTENT}")
      string(REPLACE "\"" "\\\"" SQL_CONTENT "${SQL_CONTENT}")
      string(REPLACE "\n" "\\n\"\n\"" SQL_CONTENT "${SQL_CONTENT}")

      # Define the string constant for the vector
      file(APPEND "${MIGRATIONS_HEADER}" "  {\"${MIGRATION_NAME}\", \"${SQL_CONTENT}\"},\n")

      set(FOUND_MIGRATIONS TRUE)
    endforeach()
  endif()
endforeach()

# Close the vector
file(APPEND "${MIGRATIONS_HEADER}" "};\n\n")

# Close the namespace and header
file(APPEND "${MIGRATIONS_HEADER}" "} // namespace Migrations\n\n#endif // MIGRATIONS_H\n")

# Report status
if(FOUND_MIGRATIONS)
  message(STATUS "Generated migrations.h with ${CMAKE_LIST_LENGTH} SQL migration entries")
else()
  message(WARNING "No SQL migration files found in ${MIGRATIONS_DIR}")
endif()
