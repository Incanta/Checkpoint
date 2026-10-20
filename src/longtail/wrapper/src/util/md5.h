#pragma once

#include <cstddef>
#include <cstdint>

/**
 * MD5, for the content hashes the daemon keeps as each file's baseline (it
 * compares them with Node's crypto md5, so the digests must be the standard
 * ones). Adapted from Alexander Peslyak's public domain implementation
 * (http://openwall.info/wiki/people/solar/software/public-domain-source-code/md5),
 * in a namespace so it cannot collide with OpenSSL's MD5_* symbols, which the
 * addon also links on Linux.
 */
namespace checkpoint_md5 {

struct Context {
  uint32_t lo, hi;
  uint32_t a, b, c, d;
  unsigned char buffer[64];
  uint32_t block[16];
};

void Init(Context* ctx);
void Update(Context* ctx, const void* data, size_t size);
void Final(unsigned char result[16], Context* ctx);

/** Writes the 32 lowercase hex digits of `digest` and a terminating NUL. */
void ToHex(const unsigned char digest[16], char out[33]);

}  // namespace checkpoint_md5
