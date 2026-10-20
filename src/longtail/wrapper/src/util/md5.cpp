/*
 * This is an OpenSSL-compatible implementation of the RSA Data Security, Inc.
 * MD5 Message-Digest Algorithm (RFC 1321).
 *
 * Homepage:
 * http://openwall.info/wiki/people/solar/software/public-domain-source-code/md5
 *
 * Author:
 * Alexander Peslyak, better known as Solar Designer <solar at openwall.com>
 *
 * This software was written by Alexander Peslyak in 2001.  No copyright is
 * claimed, and the software is hereby placed in the public domain.
 * In case this attempt to disclaim copyright and place the software in the
 * public domain is deemed null and void, then the software is
 * Copyright (c) 2001 Alexander Peslyak and it is hereby released to the
 * general public under the following terms:
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted.
 *
 * There's ABSOLUTELY NO WARRANTY, express or implied.
 *
 * (This is a heavily cut-down "BSD license".)
 *
 * Changes for Checkpoint: C++ namespace instead of MD5_* names, fixed-width
 * types, size_t lengths, and a memcpy load on little-endian targets.
 */

#include "md5.h"

#include <cstring>

namespace checkpoint_md5 {

namespace {

/*
 * The basic MD5 functions.
 *
 * F and G are optimized compared to their RFC 1321 definitions for
 * architectures that lack an AND-NOT instruction, just like in Colin Plumb's
 * implementation.
 */
#define F(x, y, z) ((z) ^ ((x) & ((y) ^ (z))))
#define G(x, y, z) ((y) ^ ((z) & ((x) ^ (y))))
#define H(x, y, z) (((x) ^ (y)) ^ (z))
#define H2(x, y, z) ((x) ^ ((y) ^ (z)))
#define I(x, y, z) ((y) ^ ((x) | ~(z)))

/*
 * The MD5 transformation for all four rounds.
 */
#define STEP(f, a, b, c, d, x, t, s)                      \
  (a) += f((b), (c), (d)) + (x) + (t);                    \
  (a) = (((a) << (s)) | (((a) & 0xffffffff) >> (32 - (s)))); \
  (a) += (b);

/*
 * SET reads 4 input bytes in little-endian byte order and stores them in a
 * properly aligned word in host byte order.
 */
#if defined(_WIN32) || defined(__i386__) || defined(__x86_64__) || \
    (defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__)
#define SET(n) (std::memcpy(&ctx->block[(n)], &ptr[(n) * 4], 4), ctx->block[(n)])
#else
#define SET(n)                                      \
  (ctx->block[(n)] = (uint32_t)ptr[(n) * 4] |       \
                     ((uint32_t)ptr[(n) * 4 + 1] << 8) | \
                     ((uint32_t)ptr[(n) * 4 + 2] << 16) | \
                     ((uint32_t)ptr[(n) * 4 + 3] << 24))
#endif
#define GET(n) (ctx->block[(n)])

/*
 * This processes one or more 64-byte data blocks, but does NOT update the bit
 * counters. There are no alignment requirements.
 */
const void* Body(Context* ctx, const void* data, size_t size) {
  const unsigned char* ptr = static_cast<const unsigned char*>(data);
  uint32_t a = ctx->a;
  uint32_t b = ctx->b;
  uint32_t c = ctx->c;
  uint32_t d = ctx->d;

  do {
    const uint32_t saved_a = a;
    const uint32_t saved_b = b;
    const uint32_t saved_c = c;
    const uint32_t saved_d = d;

    /* Round 1 */
    STEP(F, a, b, c, d, SET(0), 0xd76aa478, 7)
    STEP(F, d, a, b, c, SET(1), 0xe8c7b756, 12)
    STEP(F, c, d, a, b, SET(2), 0x242070db, 17)
    STEP(F, b, c, d, a, SET(3), 0xc1bdceee, 22)
    STEP(F, a, b, c, d, SET(4), 0xf57c0faf, 7)
    STEP(F, d, a, b, c, SET(5), 0x4787c62a, 12)
    STEP(F, c, d, a, b, SET(6), 0xa8304613, 17)
    STEP(F, b, c, d, a, SET(7), 0xfd469501, 22)
    STEP(F, a, b, c, d, SET(8), 0x698098d8, 7)
    STEP(F, d, a, b, c, SET(9), 0x8b44f7af, 12)
    STEP(F, c, d, a, b, SET(10), 0xffff5bb1, 17)
    STEP(F, b, c, d, a, SET(11), 0x895cd7be, 22)
    STEP(F, a, b, c, d, SET(12), 0x6b901122, 7)
    STEP(F, d, a, b, c, SET(13), 0xfd987193, 12)
    STEP(F, c, d, a, b, SET(14), 0xa679438e, 17)
    STEP(F, b, c, d, a, SET(15), 0x49b40821, 22)

    /* Round 2 */
    STEP(G, a, b, c, d, GET(1), 0xf61e2562, 5)
    STEP(G, d, a, b, c, GET(6), 0xc040b340, 9)
    STEP(G, c, d, a, b, GET(11), 0x265e5a51, 14)
    STEP(G, b, c, d, a, GET(0), 0xe9b6c7aa, 20)
    STEP(G, a, b, c, d, GET(5), 0xd62f105d, 5)
    STEP(G, d, a, b, c, GET(10), 0x02441453, 9)
    STEP(G, c, d, a, b, GET(15), 0xd8a1e681, 14)
    STEP(G, b, c, d, a, GET(4), 0xe7d3fbc8, 20)
    STEP(G, a, b, c, d, GET(9), 0x21e1cde6, 5)
    STEP(G, d, a, b, c, GET(14), 0xc33707d6, 9)
    STEP(G, c, d, a, b, GET(3), 0xf4d50d87, 14)
    STEP(G, b, c, d, a, GET(8), 0x455a14ed, 20)
    STEP(G, a, b, c, d, GET(13), 0xa9e3e905, 5)
    STEP(G, d, a, b, c, GET(2), 0xfcefa3f8, 9)
    STEP(G, c, d, a, b, GET(7), 0x676f02d9, 14)
    STEP(G, b, c, d, a, GET(12), 0x8d2a4c8a, 20)

    /* Round 3 */
    STEP(H, a, b, c, d, GET(5), 0xfffa3942, 4)
    STEP(H2, d, a, b, c, GET(8), 0x8771f681, 11)
    STEP(H, c, d, a, b, GET(11), 0x6d9d6122, 16)
    STEP(H2, b, c, d, a, GET(14), 0xfde5380c, 23)
    STEP(H, a, b, c, d, GET(1), 0xa4beea44, 4)
    STEP(H2, d, a, b, c, GET(4), 0x4bdecfa9, 11)
    STEP(H, c, d, a, b, GET(7), 0xf6bb4b60, 16)
    STEP(H2, b, c, d, a, GET(10), 0xbebfbc70, 23)
    STEP(H, a, b, c, d, GET(13), 0x289b7ec6, 4)
    STEP(H2, d, a, b, c, GET(0), 0xeaa127fa, 11)
    STEP(H, c, d, a, b, GET(3), 0xd4ef3085, 16)
    STEP(H2, b, c, d, a, GET(6), 0x04881d05, 23)
    STEP(H, a, b, c, d, GET(9), 0xd9d4d039, 4)
    STEP(H2, d, a, b, c, GET(12), 0xe6db99e5, 11)
    STEP(H, c, d, a, b, GET(15), 0x1fa27cf8, 16)
    STEP(H2, b, c, d, a, GET(2), 0xc4ac5665, 23)

    /* Round 4 */
    STEP(I, a, b, c, d, GET(0), 0xf4292244, 6)
    STEP(I, d, a, b, c, GET(7), 0x432aff97, 10)
    STEP(I, c, d, a, b, GET(14), 0xab9423a7, 15)
    STEP(I, b, c, d, a, GET(5), 0xfc93a039, 21)
    STEP(I, a, b, c, d, GET(12), 0x655b59c3, 6)
    STEP(I, d, a, b, c, GET(3), 0x8f0ccc92, 10)
    STEP(I, c, d, a, b, GET(10), 0xffeff47d, 15)
    STEP(I, b, c, d, a, GET(1), 0x85845dd1, 21)
    STEP(I, a, b, c, d, GET(8), 0x6fa87e4f, 6)
    STEP(I, d, a, b, c, GET(15), 0xfe2ce6e0, 10)
    STEP(I, c, d, a, b, GET(6), 0xa3014314, 15)
    STEP(I, b, c, d, a, GET(13), 0x4e0811a1, 21)
    STEP(I, a, b, c, d, GET(4), 0xf7537e82, 6)
    STEP(I, d, a, b, c, GET(11), 0xbd3af235, 10)
    STEP(I, c, d, a, b, GET(2), 0x2ad7d2bb, 15)
    STEP(I, b, c, d, a, GET(9), 0xeb86d391, 21)

    a += saved_a;
    b += saved_b;
    c += saved_c;
    d += saved_d;

    ptr += 64;
  } while (size -= 64);

  ctx->a = a;
  ctx->b = b;
  ctx->c = c;
  ctx->d = d;

  return ptr;
}

#undef F
#undef G
#undef H
#undef H2
#undef I
#undef STEP
#undef SET
#undef GET

void Out(unsigned char* dst, uint32_t src) {
  dst[0] = static_cast<unsigned char>(src);
  dst[1] = static_cast<unsigned char>(src >> 8);
  dst[2] = static_cast<unsigned char>(src >> 16);
  dst[3] = static_cast<unsigned char>(src >> 24);
}

}  // namespace

void Init(Context* ctx) {
  ctx->a = 0x67452301;
  ctx->b = 0xefcdab89;
  ctx->c = 0x98badcfe;
  ctx->d = 0x10325476;

  ctx->lo = 0;
  ctx->hi = 0;
}

void Update(Context* ctx, const void* data, size_t size) {
  const uint32_t saved_lo = ctx->lo;
  if ((ctx->lo = (saved_lo + static_cast<uint32_t>(size)) & 0x1fffffff) < saved_lo) {
    ctx->hi++;
  }
  ctx->hi += static_cast<uint32_t>(static_cast<uint64_t>(size) >> 29);

  const size_t used = saved_lo & 0x3f;

  if (used) {
    const size_t available = 64 - used;

    if (size < available) {
      std::memcpy(&ctx->buffer[used], data, size);
      return;
    }

    std::memcpy(&ctx->buffer[used], data, available);
    data = static_cast<const unsigned char*>(data) + available;
    size -= available;
    Body(ctx, ctx->buffer, 64);
  }

  if (size >= 64) {
    data = Body(ctx, data, size & ~static_cast<size_t>(0x3f));
    size &= 0x3f;
  }

  std::memcpy(ctx->buffer, data, size);
}

void Final(unsigned char result[16], Context* ctx) {
  size_t used = ctx->lo & 0x3f;

  ctx->buffer[used++] = 0x80;

  size_t available = 64 - used;

  if (available < 8) {
    std::memset(&ctx->buffer[used], 0, available);
    Body(ctx, ctx->buffer, 64);
    used = 0;
    available = 64;
  }

  std::memset(&ctx->buffer[used], 0, available - 8);

  ctx->lo <<= 3;
  Out(&ctx->buffer[56], ctx->lo);
  Out(&ctx->buffer[60], ctx->hi);

  Body(ctx, ctx->buffer, 64);

  Out(&result[0], ctx->a);
  Out(&result[4], ctx->b);
  Out(&result[8], ctx->c);
  Out(&result[12], ctx->d);

  std::memset(ctx, 0, sizeof(*ctx));
}

void ToHex(const unsigned char digest[16], char out[33]) {
  static const char kDigits[] = "0123456789abcdef";
  for (int i = 0; i < 16; ++i) {
    out[i * 2] = kDigits[digest[i] >> 4];
    out[i * 2 + 1] = kDigits[digest[i] & 0x0f];
  }
  out[32] = '\0';
}

}  // namespace checkpoint_md5
