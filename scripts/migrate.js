const { program } = require("commander");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs").promises;

program
  .name("yarn prisma:migrate")
  .description(
    "Script for generating database migrations; if the generated migration is empty, it's ignored.",
  )
  .argument("name", "Migration name")
  .option(
    "-p, --port <PORT>",
    "Port to use for the Postgres shadow database",
    "5433",
  )
  .action(async (name, options) => {
    const migrationName = `${new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, -3)}_${name}`;

    const baseFolder = "src/app/prisma";

    const providers = ["sqlite", "postgresql"];
    const migrations = [];

    for (const provider of providers) {
      console.log(`Generating migration for provider: ${provider}...`);

      const migrationsFolder = path.resolve(
        __dirname,
        "..",
        baseFolder,
        `migrations-${provider}`,
      );

      // run yarn db:set-provider in the app dir
      execSync(`yarn db:set-provider:${provider}`, {
        stdio: "inherit",
        cwd: path.resolve(__dirname, "..", "src", "app"),
      });

      // concat datasource.prisma and schema.prisma into a temp file, since prisma migrate diff doesn't support multiple schema paths
      const datasource = await fs.readFile(
        path.resolve(__dirname, "..", baseFolder, "datasource.prisma"),
        "utf-8",
      );
      const schema = await fs.readFile(
        path.resolve(__dirname, "..", baseFolder, "schema.prisma"),
        "utf-8",
      );
      const tempSchemaPath = path.resolve(
        __dirname,
        "..",
        baseFolder,
        `temp-${provider}-schema.prisma`,
      );
      await fs.writeFile(tempSchemaPath, `${datasource}\n\n${schema}`);

      const args = [
        "prisma",
        "migrate diff",
        "--from-migrations",
        `./${baseFolder}/migrations-${provider}`,
        "--to-schema-datamodel",
        tempSchemaPath,
        "--script",
        "--shadow-database-url",
        provider === "postgresql"
          ? `postgresql://postgres:postgres@localhost:${options.port}/shadow`
          : "file:./dev-shadow.db",
      ];

      const output = execSync(args.join(" "), {
        stdio: "pipe",
        encoding: "utf-8",
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          NODE_CONFIG_DIR: "./src/app/config",
          PATH: `${path.resolve(__dirname, "..", "node_modules/.bin")}${path.delimiter}${process.env.PATH}`,
        },
      });

      // delete temp schema file
      await fs.unlink(tempSchemaPath);

      if (provider === "sqlite") {
        // delete shadow db if it exists
        const shadowDbPath = path.resolve(
          __dirname,
          "..",
          baseFolder,
          "dev-shadow.db",
        );
        if (fs.existsSync(shadowDbPath)) {
          await fs.unlink(shadowDbPath);
        }
      }

      if (!output.includes("-- This is an empty migration.")) {
        await fs.mkdir(path.join(migrationsFolder, migrationName), {
          recursive: true,
        });

        await fs.writeFile(
          path.join(migrationsFolder, migrationName, "migration.sql"),
          output,
        );

        migrations.push(provider);
      }
    }

    if (migrations.length === 0) {
      console.log("No changes detected in the schema. No migration generated.");
    } else {
      console.log(
        `Migration generated for providers: ${migrations.join(", ")}`,
      );
    }
  });

program.parse(process.argv);
