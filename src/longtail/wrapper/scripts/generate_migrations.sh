#!/bin/bash

# This script generates a C++ header with SQL migration contents as string constants


MIGRATIONS_DIR=prisma/migrations
MIGRATIONS_HEADER=build/include/migrations.h

echo "Generating migrations.h from $MIGRATIONS_DIR"

# Check if the migrations directory exists
if [ ! -d "$MIGRATIONS_DIR" ]; then
    echo "WARNING: Migrations directory not found: $MIGRATIONS_DIR"
    # Create a minimal header file
    cat > "$MIGRATIONS_HEADER" << EOF
#ifndef MIGRATIONS_H
#define MIGRATIONS_H

#include <string>
#include <vector>

namespace Migrations {

// Auto-generated - DO NOT EDIT MANUALLY
static const std::vector< std::pair<std::string, std::string> > migrations = {};

} // namespace Migrations

#endif // MIGRATIONS_H
EOF
    exit 0
fi

# Start the header file with include guards and basic structure
cat > "$MIGRATIONS_HEADER" << EOF
#ifndef MIGRATIONS_H
#define MIGRATIONS_H

#include <string>
#include <vector>

namespace Migrations {

EOF

# Write file generation timestamp comment
TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")
echo "// Auto-generated on $TIMESTAMP" >> "$MIGRATIONS_HEADER"
echo "// DO NOT EDIT MANUALLY" >> "$MIGRATIONS_HEADER"
echo "" >> "$MIGRATIONS_HEADER"

# Write a vector declaration to store all migrations
echo "// Vector of migration names to their SQL content" >> "$MIGRATIONS_HEADER"
echo "static const std::vector< std::pair<std::string, std::string> > migrations = {" >> "$MIGRATIONS_HEADER"

# Keep track if we've added any migrations
FOUND_MIGRATIONS=0

# Scan for migration directories and sort them
MIGRATION_DIRS=$(find "$MIGRATIONS_DIR" -mindepth 1 -maxdepth 1 -type d | sort)

# Process each migration directory
for DIR in $MIGRATION_DIRS; do
    # Get the directory name (migration name)
    MIGRATION_NAME=$(basename "$DIR")
    echo "Processing migration: $MIGRATION_NAME"

    # Get the SQL file(s) in this migration directory
    SQL_FILES=$(find "$DIR" -name "*.sql")

    for SQL_FILE in $SQL_FILES; do
        # Get filename
        FILE_NAME=$(basename "$SQL_FILE")
        echo "  Processing SQL file: $FILE_NAME"

        # Read the SQL file content
        SQL_CONTENT=$(<"$SQL_FILE")

        # Escape special characters for C++ string
        # 1. Escape backslashes
        SQL_CONTENT="${SQL_CONTENT//\\/\\\\}"
        # 2. Escape double quotes
        SQL_CONTENT="${SQL_CONTENT//\"/\\\"}"

        # Define the string constant for the vector
        echo "  {\"$MIGRATION_NAME\", R\"MIGRATION_DELIM($SQL_CONTENT)MIGRATION_DELIM\"}," >> "$MIGRATIONS_HEADER"

        FOUND_MIGRATIONS=1
    done
done

# Close the vector
echo "};" >> "$MIGRATIONS_HEADER"
echo "" >> "$MIGRATIONS_HEADER"

# Close the namespace and header
echo "} // namespace Migrations" >> "$MIGRATIONS_HEADER"
echo "" >> "$MIGRATIONS_HEADER"
echo "#endif // MIGRATIONS_H" >> "$MIGRATIONS_HEADER"

# Report status
if [ $FOUND_MIGRATIONS -eq 1 ]; then
    echo "Generated migrations.h with SQL migration entries"
else
    echo "WARNING: No SQL migration files found in $MIGRATIONS_DIR"
fi

