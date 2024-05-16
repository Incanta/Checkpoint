const fs = require("fs");
const path = require("path");
const execSync = require("child_process").execSync;

const packagesFolder = path.join(process.cwd(), "packages");
const packages = fs.readdirSync(packagesFolder, {
  encoding: "utf-8",
  withFileTypes: true,
});

// equivalent of `rm -rf packages/*/lib packages/*/tsconfig.tsbuildinfo`
for (const p of packages) {
  if (p.isDirectory()) {
    try {
      fs.rm(
        path.join(packagesFolder, p.name, "lib"),
        {
          recursive: true,
          force: true,
        },
        () => {}
      );
    } catch (e) {
      // do nothing
      console.log(e);
    }

    try {
      fs.rm(
        path.join(packagesFolder, p.name, "tsconfig.tsbuildinfo"),
        {
          force: true,
        },
        () => {}
      );
    } catch (e) {
      // do nothing
      console.log(e);
    }
  }
}

if (process.argv.length > 2 && process.argv[2].toLowerCase() === "all") {
  execSync("lerna clean -y");

  // equivalent of `rm -rf node_modules`
  try {
    fs.rm(
      path.join(process.cwd(), "node_modules"),
      {
        recursive: true,
        force: true,
      },
      () => {}
    );
  } catch (e) {
    // do nothing
  }
}
