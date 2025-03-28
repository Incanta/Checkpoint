-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "checkpointAdmin" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "Org" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deletedAt" DATETIME,
    "deletedBy" TEXT,
    "name" TEXT NOT NULL,
    "defaultRepoAccess" TEXT NOT NULL DEFAULT 'WRITE',
    "defaultCanCreateRepos" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "OrgUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "canCreateRepos" BOOLEAN NOT NULL DEFAULT true,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "OrgUser_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OrgUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Repo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deletedAt" DATETIME,
    "deletedBy" TEXT,
    "name" TEXT NOT NULL,
    "public" BOOLEAN NOT NULL DEFAULT false,
    "orgId" TEXT NOT NULL,
    CONSTRAINT "Repo_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RepoRole" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "access" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "RepoRole_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RepoRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "headNumber" INTEGER NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Branch_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChangeList" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "number" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "userId" TEXT,
    "parentNumber" INTEGER,
    CONSTRAINT "ChangeList_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ChangeList_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ChangeList_repoId_parentNumber_fkey" FOREIGN KEY ("repoId", "parentNumber") REFERENCES "ChangeList" ("repoId", "number") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FileChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fileId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "changeListNumber" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "oldPath" TEXT,
    CONSTRAINT "FileChange_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FileChange_repoId_changeListNumber_fkey" FOREIGN KEY ("repoId", "changeListNumber") REFERENCES "ChangeList" ("repoId", "number") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "File" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "path" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    CONSTRAINT "File_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FileLock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlockedAt" DATETIME,
    "fileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "FileLock_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FileLock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Org_name_key" ON "Org"("name");

-- CreateIndex
CREATE UNIQUE INDEX "OrgUser_orgId_userId_key" ON "OrgUser"("orgId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Repo_orgId_name_key" ON "Repo"("orgId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "RepoRole_repoId_userId_key" ON "RepoRole"("repoId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_repoId_name_key" ON "Branch"("repoId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeList_repoId_number_key" ON "ChangeList"("repoId", "number");
