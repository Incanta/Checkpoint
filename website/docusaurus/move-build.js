/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require("fs");
const fsExtra = require("fs-extra");
const path = require("path");

const sourceBuildPath = path.join(__dirname, "build");
const targetBuildPath = path.join(__dirname, "..", "out");

// Clean existing docusaurus directories from the Next.js output
const dirsToClean = ["assets", "blog", "docs"];
for (const dir of dirsToClean) {
  try {
    fs.rmSync(path.join(targetBuildPath, dir), { recursive: true });
  } catch (e) {}
}

const filesToClean = [".nojekyll", "docusaurus-sitemap.xml"];
for (const file of filesToClean) {
  try {
    fs.rmSync(path.join(targetBuildPath, file), { force: true });
  } catch (e) {}
}

// Copy docusaurus build output into Next.js output
for (const dir of dirsToClean) {
  const src = path.join(sourceBuildPath, dir);
  if (fs.existsSync(src)) {
    fsExtra.copySync(src, path.join(targetBuildPath, dir));
    console.log(`Copied ${dir}/`);
  }
}

for (const file of filesToClean) {
  const src = path.join(sourceBuildPath, file);
  if (fs.existsSync(src)) {
    fsExtra.copySync(src, path.join(targetBuildPath, file));
    console.log(`Copied ${file}`);
  }
}

console.log("Docusaurus build merged into out/");
