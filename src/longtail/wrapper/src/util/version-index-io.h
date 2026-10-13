#pragma once

#include <errno.h>
#include <longtail.h>
#include <stdint.h>
#include <string.h>

#include <string>

// Version indexes are content addressed: the file is named after the SHA-256
// of its bytes ("<64 hex>.lvi"). Two submits can then only share a name if
// they wrote the same bytes, so one can never replace the other's index, and a
// reader can prove the index it fetched is the one the changelist recorded.
//
// The server recomputes the hash before it creates a changelist (see
// routes/submit.ts), which is why this is SHA-256 and not one of Longtail's
// own hashes: it has to be cheap to reproduce outside the addon.
//
// Indexes written before this scheme are named "0x<hex>.lvi". They stay
// readable, but there is nothing to verify them against.

namespace version_index_io {

struct Sha256 {
  uint32_t m_State[8];
  uint64_t m_Length;
  uint8_t m_Block[64];
  size_t m_BlockUsed;

  Sha256()
      : m_State{0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au, 0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u},
        m_Length(0),
        m_BlockUsed(0) {}

  static uint32_t Rotr(uint32_t v, uint32_t n) { return (v >> n) | (v << (32 - n)); }

  void Compress(const uint8_t* p) {
    static const uint32_t k[64] = {
        0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
        0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
        0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
        0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
        0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
        0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
        0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
        0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u};

    uint32_t w[64];
    for (int i = 0; i < 16; ++i) {
      w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) | ((uint32_t)p[i * 4 + 2] << 8) | (uint32_t)p[i * 4 + 3];
    }
    for (int i = 16; i < 64; ++i) {
      uint32_t s0 = Rotr(w[i - 15], 7) ^ Rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      uint32_t s1 = Rotr(w[i - 2], 17) ^ Rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }

    uint32_t a = m_State[0], b = m_State[1], c = m_State[2], d = m_State[3];
    uint32_t e = m_State[4], f = m_State[5], g = m_State[6], h = m_State[7];
    for (int i = 0; i < 64; ++i) {
      uint32_t s1 = Rotr(e, 6) ^ Rotr(e, 11) ^ Rotr(e, 25);
      uint32_t ch = (e & f) ^ (~e & g);
      uint32_t t1 = h + s1 + ch + k[i] + w[i];
      uint32_t s0 = Rotr(a, 2) ^ Rotr(a, 13) ^ Rotr(a, 22);
      uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
      uint32_t t2 = s0 + maj;
      h = g;
      g = f;
      f = e;
      e = d + t1;
      d = c;
      c = b;
      b = a;
      a = t1 + t2;
    }
    m_State[0] += a;
    m_State[1] += b;
    m_State[2] += c;
    m_State[3] += d;
    m_State[4] += e;
    m_State[5] += f;
    m_State[6] += g;
    m_State[7] += h;
  }

  void Update(const void* data, size_t size) {
    const uint8_t* p = (const uint8_t*)data;
    m_Length += size;
    while (size > 0) {
      if (m_BlockUsed == 0 && size >= 64) {
        Compress(p);
        p += 64;
        size -= 64;
        continue;
      }
      size_t take = 64 - m_BlockUsed;
      if (take > size) take = size;
      memcpy(m_Block + m_BlockUsed, p, take);
      m_BlockUsed += take;
      p += take;
      size -= take;
      if (m_BlockUsed == 64) {
        Compress(m_Block);
        m_BlockUsed = 0;
      }
    }
  }

  std::string FinalHex() {
    const uint64_t bit_length = m_Length * 8;
    const uint8_t one = 0x80;
    const uint8_t zero = 0;
    Update(&one, 1);
    while (m_BlockUsed != 56) {
      Update(&zero, 1);
    }
    uint8_t length_be[8];
    for (int i = 0; i < 8; ++i) {
      length_be[i] = (uint8_t)(bit_length >> (56 - i * 8));
    }
    Update(length_be, 8);

    static const char* digits = "0123456789abcdef";
    std::string hex;
    hex.reserve(64);
    for (int i = 0; i < 8; ++i) {
      for (int shift = 28; shift >= 0; shift -= 4) {
        hex.push_back(digits[(m_State[i] >> shift) & 0xf]);
      }
    }
    return hex;
  }
};

inline std::string Sha256Hex(const void* data, size_t size) {
  Sha256 hasher;
  hasher.Update(data, size);
  return hasher.FinalHex();
}

/** The storage file name for a serialized version index. */
inline std::string NameForContent(const void* data, size_t size) {
  return Sha256Hex(data, size) + ".lvi";
}

/** True for "<64 lowercase hex>.lvi", the only names that can be verified. */
inline bool IsContentName(const std::string& name) {
  if (name.size() != 68 || name.compare(64, 4, ".lvi") != 0) {
    return false;
  }
  for (size_t i = 0; i < 64; ++i) {
    const char c = name[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
      return false;
    }
  }
  return true;
}

/**
 * Writes an already serialized version index. Like every write through the
 * storage adapters, a zero return does not mean the upload succeeded; the
 * caller still has to check the adapter's UploadFailures.
 */
inline int WriteBuffer(struct Longtail_StorageAPI* storage_api, const char* path, const void* data, size_t size) {
  Longtail_StorageAPI_HOpenFile file_handle;
  int err = storage_api->OpenWriteFile(storage_api, path, 0, &file_handle);
  if (err) {
    return err;
  }
  err = storage_api->Write(storage_api, file_handle, 0, size, data);
  storage_api->CloseFile(storage_api, file_handle);
  return err;
}

/**
 * Reads a version index and, when its name is a content name, proves the bytes
 * match it. Returns EBADMSG when they do not: the index in storage is not the
 * one the changelist was created with, and nothing built from it can be
 * trusted.
 */
inline int ReadVerified(
    struct Longtail_StorageAPI* storage_api,
    const char* path,
    const std::string& name,
    struct Longtail_VersionIndex** out_version_index) {
  Longtail_StorageAPI_HOpenFile file_handle;
  int err = storage_api->OpenReadFile(storage_api, path, &file_handle);
  if (err) {
    return err;
  }
  uint64_t size = 0;
  err = storage_api->GetSize(storage_api, file_handle, &size);
  if (err) {
    storage_api->CloseFile(storage_api, file_handle);
    return err;
  }
  if (size == 0) {
    storage_api->CloseFile(storage_api, file_handle);
    return EBADMSG;
  }
  void* buffer = Longtail_Alloc("ReadVerifiedVersionIndex", (size_t)size);
  if (!buffer) {
    storage_api->CloseFile(storage_api, file_handle);
    return ENOMEM;
  }
  err = storage_api->Read(storage_api, file_handle, 0, size, buffer);
  storage_api->CloseFile(storage_api, file_handle);
  if (err) {
    Longtail_Free(buffer);
    return err;
  }

  if (IsContentName(name) && NameForContent(buffer, (size_t)size) != name) {
    Longtail_Free(buffer);
    return EBADMSG;
  }

  err = Longtail_ReadVersionIndexFromBuffer(buffer, (size_t)size, out_version_index);
  Longtail_Free(buffer);
  return err;
}

}  // namespace version_index_io
