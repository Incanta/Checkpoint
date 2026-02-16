#!/usr/bin/env bash
# Build longtail static library with MSVC from Git Bash,
# then copy everything to the wrapper's longtail/ directory.
#
# Usage: ./build-and-copy-msvc.sh
#
# This script invokes cmd.exe to run the .bat file so that
# vcvars64.bat environment setup works correctly.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Building longtail static lib with MSVC ==="
cmd //c "$(cygpath -w "$SCRIPT_DIR/build-and-copy-msvc.bat")"

echo ""
echo "=== Done ==="
echo "MSVC longtail.lib has been built and copied to wrapper/longtail/"
