#pragma once

#ifndef BeforeVersion
  #define BeforeVersion(Major, Minor) \
    (ENGINE_MAJOR_VERSION < Major || \
     (ENGINE_MAJOR_VERSION == Major && ENGINE_MINOR_VERSION < Minor))
#endif

#ifndef StartingInVersion
  #define StartingInVersion(Major, Minor) \
    (ENGINE_MAJOR_VERSION > Major || \
     (ENGINE_MAJOR_VERSION == Major && ENGINE_MINOR_VERSION >= Minor))
#endif
