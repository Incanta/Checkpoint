newoption
{
    trigger = 'to',
    default = 'build',
    value   = 'path',
    description = 'Set the output location for the generated files'
}

workspace "longtail"
   configurations { "Debug", "Release" }
   platforms { 'x86_64' }   
   location ( _OPTIONS["to"] )
   intrinsics "on"
   vectorextensions "AVX2"
   symbols "On"
   exceptionhandling ("off")
   defines { '_CRT_SECURE_NO_DEPRECATE', '_CRT_SECURE_NO_WARNINGS', '_CRT_NONSTDC_NO_WARNINGS', '/D_HAS_EXCEPTIONS=0' }

   filter "configurations:Debug"
      runtime "Debug"
      defines { "DEBUG" }

   filter "configurations:Release"
      runtime "Release"
      defines { "NDEBUG" }
      optimize "On"

project "longtail-src"
   kind "StaticLib"
   language ("C")
   files { 'src/*.c', 'src/*.h', 'src/ext/*.h', 'src/ext/*.c'}

project "longtail-lib"
   kind "StaticLib"
   language ("C")
   warnings "Default"
   files { 'lib/**/*.c', 'lib/**/*.h', 'lib/*.c', 'lib/*.h' }
   removefiles { 'lib/**/ext/**'}

project "longtail-lib-ext"
   kind "StaticLib"
   language ("C")
   warnings "Off"
   files { 'lib/**/ext/**.c', 'lib/**/ext/**.h'}
   removefiles { 'lib/blake3/ext/*_neon.c'}

project "longtail-cli"
   kind "ConsoleApp"
   language ("C")
   warnings "Default"
   files { 'cmd/*.c', 'cmd/*.h', 'cmd/ext/*.h' }
   links { "longtail-src" }
   links { "longtail-lib" }
   links { "longtail-lib-ext" }

project "longtail-tests"
   kind "ConsoleApp"
   debugdir ("test")
   language ("C++")
   warnings "Default"
   files { 'test/*.cpp', 'test/*.h', 'test/ext/*.h' }
   links { "longtail-src" }
   links { "longtail-lib" }
   links { "longtail-lib-ext" }
