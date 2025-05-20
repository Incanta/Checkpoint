const fs = require("fs");
const path = require("path");

const seedPath = path.join(__dirname, "prisma", "seed");
const migrationsPath = path.join(__dirname, "prisma", "migrations");

const migrationFolders = fs
  .readdirSync(migrationsPath)
  .filter((folder) =>
    fs.statSync(path.join(migrationsPath, folder)).isDirectory()
  )
  .map((folder) => {
    return path.join(migrationsPath, folder);
  });

const initMigrationFolder = migrationFolders.find((folder) =>
  folder.endsWith("init")
);

if (!initMigrationFolder) {
  console.error("No init migration folder found");
  process.exit(1);
}

const initMigrationTimestamp = parseInt(
  path.basename(initMigrationFolder).split("_")[0],
  10
);

fs.cpSync(
  seedPath,
  path.join(
    path.dirname(initMigrationFolder),
    `${initMigrationTimestamp + 1}_seed`
  ),
  { recursive: true, force: true }
);
