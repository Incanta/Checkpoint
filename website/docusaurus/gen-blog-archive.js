/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require("fs");
const path = require("path");

const archivePath = path.join(
  __dirname,
  ".docusaurus",
  "docusaurus-plugin-content-blog",
  "default",
  "p",
);

// The archive filename contains a hash that may change between builds
const files = fs.readdirSync(archivePath).filter(f => f.startsWith("blog-archive-") && f.endsWith(".json"));

if (files.length === 0) {
  console.error("Could not find blog-archive JSON in .docusaurus cache");
  process.exit(1);
}

const blogArchive = JSON.parse(
  fs.readFileSync(path.join(archivePath, files[0]), "utf-8"),
);

const outputPath = path.join(__dirname, "..", "src", "blog-archive.json");
fs.writeFileSync(outputPath, JSON.stringify(blogArchive.archive));

console.log(`Blog archive written to ${outputPath}`);
