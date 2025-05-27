/* eslint-disable @typescript-eslint/no-var-requires */
const { program } = require("commander");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs").promises;

program
  .name("yarn migrate:dev")
  .description(
    "Script for generating database migrations; if the generated migration is empty, it's ignored.",
  )
  .argument("name", "Migration name")
  .option("-p, --port <PORT>", "Port to use for the shadow database", "5433")
  .action(async (name, options) => {
    const migrationName = `${new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, -3)}_${name}`;

    const baseFolder = "api/db";

    let generated = false;

    const migrationsFolder = path.resolve(
      __dirname,
      "..",
      baseFolder,
      "migrations",
    );

    const args = [
      "yarn rw prisma",
      "migrate diff",
      "--from-migrations",
      `./${baseFolder}/migrations`,
      "--to-schema-datamodel",
      `./${baseFolder}/schema.prisma`,
      "--script",
      "--shadow-database-url",
      `postgresql://postgres:postgres@localhost:${options.port}/shadow`,
    ];

    const output = execSync(args.join(" "), {
      stdio: "pipe",
      encoding: "utf-8",
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        NODE_CONFIG_DIR: "./config/node",
      },
    });

    if (!output.includes("-- This is an empty migration.")) {
      await fs.mkdir(path.join(migrationsFolder, migrationName), {
        recursive: true,
      });

      const lines = output.replaceAll("\r", "").split("\n");
      const filteredLines = lines.slice(4).join("\n");

      await fs.writeFile(
        path.join(migrationsFolder, migrationName, "migration.sql"),
        filteredLines,
      );

      generated = true;
    }

    if (!generated) {
      // eslint-disable-next-line no-console
      console.log("No migration generated/needed.");
      return;
    }

    // eslint-disable-next-line no-console
    console.log(`Migration generated.`);
  });

program.parse(process.argv);
