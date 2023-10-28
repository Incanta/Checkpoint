{
  "targets": [{
    "target_name": "longtail",
    "cflags!": [ "-fno-exceptions" ],
    "cflags_cc!": [ "-fno-exceptions" ],
    "sources": [
      "src/addon.cpp",
      "src/storage-api.cpp"
    ],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")"
    ],
    "libraries": [],
    'dependencies': [
      "<!(node -p \"require('node-addon-api').gyp\")"
    ],
    "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
    "conditions": [
      [ "OS=='linux'", {
        "libraries": [
          "-Wl,-rpath",
          "-L./src/longtail",
          "-llongtail_linux_x64"
        ]
      }],
      [ "OS=='win'", {
        "libraries": [
          "<(module_root_dir)/src/longtail/longtail_win32_x64.lib",
        ],
        "copies": [
          {
            "destination": "<(module_root_dir)/build/Release/",
            "files": [ "<(module_root_dir)/src/longtail/longtail_win32_x64.dll" ]
          }
        ]
      }]
    ]
  }]
}