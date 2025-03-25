cmake_minimum_required(VERSION 3.15)
project(LongtailWrapper)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED True)

include(FetchContent)
FetchContent_Declare(cpr GIT_REPOSITORY https://github.com/libcpr/cpr.git
                         GIT_TAG dd967cb48ea6bcbad9f1da5ada0db8ac0d532c06) # 1.11.2
FetchContent_MakeAvailable(cpr)

add_library(LongtailWrapper SHARED src/main.cpp src/seaweedfs.cpp src/merge.cpp)

target_include_directories(LongtailWrapper PRIVATE longtail/include/src longtail/include/lib)

find_library(LongtailLibrary longtail PATHS longtail/win32_x64/debug/)

target_link_libraries(
  LongtailWrapper
  ${LongtailLibrary}
  cpr::cpr
)

# set up an install that uses file(GET_RUNTIME_DEPENDENCIES) to copy the required DLLs
install(TARGETS LongtailWrapper
  RUNTIME DESTINATION bin
  LIBRARY DESTINATION lib
  ARCHIVE DESTINATION lib
)
install(FILES ${CMAKE_CURRENT_BINARY_DIR}/LongtailWrapper.dll DESTINATION bin)
install(FILES ${CMAKE_CURRENT_BINARY_DIR}/LongtailWrapper.lib DESTINATION lib)
install(FILES ${CMAKE_CURRENT_BINARY_DIR}/LongtailWrapper.exp DESTINATION lib)
install(FILES ${CMAKE_CURRENT_BINARY_DIR}/LongtailWrapper.pdb DESTINATION bin)
