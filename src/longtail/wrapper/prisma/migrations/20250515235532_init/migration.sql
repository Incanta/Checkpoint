-- CreateTable
CREATE TABLE "Migration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "logs" TEXT
);

-- CreateTable
CREATE TABLE "Config" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT
);

-- CreateTable
CREATE TABLE "File" (
    "path" TEXT NOT NULL PRIMARY KEY,
    "oldPath" TEXT,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "staged" BOOLEAN NOT NULL DEFAULT false,
    "changelist" INTEGER,
    "backendId" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "Migration_name_key" ON "Migration"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Config_name_key" ON "Config"("name");

-- CreateIndex
CREATE UNIQUE INDEX "File_backendId_key" ON "File"("backendId");
