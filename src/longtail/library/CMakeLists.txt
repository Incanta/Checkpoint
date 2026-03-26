# ==========================================================================
# Longtail C library — CMake build
#
# Builds all longtail C sources (core + third-party + SIMD variants) into
# a static library.  SIMD-specific sources get per-file compiler flags.
#
# Consumed by the addon CMakeLists.txt via add_subdirectory().
# ==========================================================================

cmake_minimum_required(VERSION 3.15)
project(longtail_lib C)

set(LT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}")

# ==========================================================================
# Core sources  (standard compile flags)
# ==========================================================================

file(GLOB LT_CORE_SRC
  "${LT_ROOT}/src/*.c"
  "${LT_ROOT}/lib/*.c"
  "${LT_ROOT}/lib/archiveblockstore/*.c"
  "${LT_ROOT}/lib/atomiccancel/*.c"
  "${LT_ROOT}/lib/bikeshed/*.c"
  "${LT_ROOT}/lib/blake2/*.c"
  "${LT_ROOT}/lib/blake3/*.c"
  "${LT_ROOT}/lib/blockstorestorage/*.c"
  "${LT_ROOT}/lib/brotli/*.c"
  "${LT_ROOT}/lib/cacheblockstore/*.c"
  "${LT_ROOT}/lib/compressblockstore/*.c"
  "${LT_ROOT}/lib/compressionregistry/*.c"
  "${LT_ROOT}/lib/filestorage/*.c"
  "${LT_ROOT}/lib/fsblockstore/*.c"
  "${LT_ROOT}/lib/hashregistry/*.c"
  "${LT_ROOT}/lib/hpcdcchunker/*.c"
  "${LT_ROOT}/lib/lrublockstore/*.c"
  "${LT_ROOT}/lib/lz4/*.c"
  "${LT_ROOT}/lib/memstorage/*.c"
  "${LT_ROOT}/lib/memtracer/*.c"
  "${LT_ROOT}/lib/meowhash/*.c"
  "${LT_ROOT}/lib/ratelimitedprogress/*.c"
  "${LT_ROOT}/lib/shareblockstore/*.c"
  "${LT_ROOT}/lib/zstd/*.c"
)

# ==========================================================================
# Third-party sources  (standard compile flags)
# ==========================================================================

file(GLOB LT_THIRDPARTY_SRC
  "${LT_ROOT}/src/ext/*.c"
  "${LT_ROOT}/lib/lz4/ext/*.c"
  "${LT_ROOT}/lib/brotli/ext/common/*.c"
  "${LT_ROOT}/lib/brotli/ext/dec/*.c"
  "${LT_ROOT}/lib/brotli/ext/enc/*.c"
  "${LT_ROOT}/lib/zstd/ext/common/*.c"
  "${LT_ROOT}/lib/zstd/ext/compress/*.c"
  "${LT_ROOT}/lib/zstd/ext/decompress/*.c"
)

# blake3 base sources (standard flags — no SIMD intrinsics)
set(LT_BLAKE3_BASE
  "${LT_ROOT}/lib/blake3/ext/blake3.c"
  "${LT_ROOT}/lib/blake3/ext/blake3_dispatch.c"
  "${LT_ROOT}/lib/blake3/ext/blake3_portable.c"
)

# ==========================================================================
# Architecture-specific SIMD sources
# ==========================================================================

if(CMAKE_SYSTEM_PROCESSOR MATCHES "(x86_64|AMD64|amd64|i[3-6]86)")
  set(LT_ARCH_X86 TRUE)
else()
  set(LT_ARCH_X86 FALSE)
endif()

if(LT_ARCH_X86)
  # SSE group — baseline on x64 (no extra flags needed on any compiler)
  file(GLOB LT_BLAKE2_SSE "${LT_ROOT}/lib/blake2/ext/*.c")
  set(LT_BLAKE3_SSE
    "${LT_ROOT}/lib/blake3/ext/blake3_sse2.c"
    "${LT_ROOT}/lib/blake3/ext/blake3_sse41.c"
  )
  set(LT_SSE_SRC ${LT_BLAKE2_SSE} ${LT_BLAKE3_SSE})

  # AVX2
  set(LT_AVX2_SRC "${LT_ROOT}/lib/blake3/ext/blake3_avx2.c")

  # AVX512
  set(LT_AVX512_SRC "${LT_ROOT}/lib/blake3/ext/blake3_avx512.c")

  set(LT_NEON_SRC "")

  # ZSTD .S assembly (GAS syntax — GCC/Clang only, not MSVC)
  set(LT_ASM_SRC "")
  if(NOT MSVC)
    file(GLOB LT_ASM_SRC "${LT_ROOT}/lib/zstd/ext/decompress/*.S")
  endif()
else()
  # ARM / other — use NEON for blake3, skip SSE/AVX
  set(LT_SSE_SRC "")
  set(LT_AVX2_SRC "")
  set(LT_AVX512_SRC "")
  set(LT_NEON_SRC "${LT_ROOT}/lib/blake3/ext/blake3_neon.c")
  set(LT_ASM_SRC "")
endif()

# ==========================================================================
# Static library target
# ==========================================================================

add_library(longtail STATIC
  ${LT_CORE_SRC}
  ${LT_THIRDPARTY_SRC}
  ${LT_BLAKE3_BASE}
  ${LT_SSE_SRC}
  ${LT_AVX2_SRC}
  ${LT_AVX512_SRC}
  ${LT_NEON_SRC}
  ${LT_ASM_SRC}
)

# Headers are PUBLIC so consumers (addon) automatically get them
target_include_directories(longtail PUBLIC
  "${LT_ROOT}/src"
  "${LT_ROOT}/lib"
)

# Required for linking into a shared library (.node addon)
set_target_properties(longtail PROPERTIES POSITION_INDEPENDENT_CODE ON)

# ==========================================================================
# Platform / compiler flags
# ==========================================================================

if(MSVC)
  # MSVC x64 doesn't define __SSE2__ etc. — some third-party headers need them
  target_compile_definitions(longtail PRIVATE
    WINVER=0x0A00
    _WIN32_WINNT=0x0A00
    __SSE2__
    __SSSE3__
    __SSE4_1__
  )

  # Per-file SIMD flags (SSE is baseline on x64, no flag needed)
  if(LT_AVX2_SRC)
    set_source_files_properties(${LT_AVX2_SRC} PROPERTIES COMPILE_FLAGS "/arch:AVX2")
  endif()
  if(LT_AVX512_SRC)
    set_source_files_properties(${LT_AVX512_SRC} PROPERTIES COMPILE_FLAGS "/arch:AVX512")
  endif()

elseif(LT_ARCH_X86)
  # GCC / Clang on x86 — enable SIMD instruction sets globally
  target_compile_options(longtail PRIVATE -maes -mssse3 -msse4.1 -pthread)

  # AVX2 / AVX512 need per-file flags
  if(LT_AVX2_SRC)
    set_source_files_properties(${LT_AVX2_SRC}
      PROPERTIES COMPILE_FLAGS "-msse4.2 -mavx2")
  endif()
  if(LT_AVX512_SRC)
    set_source_files_properties(${LT_AVX512_SRC}
      PROPERTIES COMPILE_FLAGS "-msse4.2 -mavx2 -mavx512vl -mavx512f")
  endif()

  # ZSTD .S assembly files
  if(LT_ASM_SRC)
    set_source_files_properties(${LT_ASM_SRC}
      PROPERTIES COMPILE_FLAGS "-fno-asynchronous-unwind-tables")
  endif()
endif()

# Disable zstd x86-64 assembly.  The .S file marks symbols as .hidden, which
# produces R_X86_64_PC32 relocations that the linker rejects when linking the
# static archive into a shared object (.node addon).  The C fallback is used
# instead — negligible performance difference for this workload.
target_compile_definitions(longtail PRIVATE ZSTD_DISABLE_ASM)

# Debug-mode assertions
target_compile_definitions(longtail PRIVATE
  $<$<CONFIG:Debug>:LONGTAIL_ASSERTS>
  $<$<CONFIG:Debug>:BIKESHED_ASSERTS>
)
