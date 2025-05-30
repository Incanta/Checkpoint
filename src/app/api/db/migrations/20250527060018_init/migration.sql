-- CreateEnum
CREATE TYPE "RepoAccess" AS ENUM ('NONE', 'READ', 'WRITE', 'ADMIN');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('MEMBER', 'BILLING', 'ADMIN');

-- CreateEnum
CREATE TYPE "FileChangeType" AS ENUM ('ADD', 'DELETE', 'MODIFY');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "checkpointAdmin" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Org" (
    "id" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "name" TEXT NOT NULL,
    "defaultRepoAccess" "RepoAccess" NOT NULL DEFAULT 'WRITE',
    "defaultCanCreateRepos" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Org_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgUser" (
    "id" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'MEMBER',
    "canCreateRepos" BOOLEAN NOT NULL DEFAULT true,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "OrgUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repo" (
    "id" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "name" TEXT NOT NULL,
    "public" BOOLEAN NOT NULL DEFAULT false,
    "orgId" TEXT NOT NULL,

    CONSTRAINT "Repo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepoRole" (
    "id" TEXT NOT NULL,
    "access" "RepoAccess" NOT NULL,
    "repoId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "RepoRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "headNumber" INTEGER NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Changelist" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "number" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "versionIndex" TEXT NOT NULL,
    "stateTree" JSONB NOT NULL,
    "repoId" TEXT NOT NULL,
    "userId" TEXT,
    "parentNumber" INTEGER,

    CONSTRAINT "Changelist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangelistTag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,

    CONSTRAINT "ChangelistTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileChange" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "changelistNumber" INTEGER NOT NULL,
    "type" "FileChangeType" NOT NULL,
    "oldPath" TEXT,

    CONSTRAINT "FileChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "File" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "path" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,

    CONSTRAINT "File_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileCheckout" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "fileId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "FileCheckout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "name" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

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
CREATE UNIQUE INDEX "Changelist_repoId_number_key" ON "Changelist"("repoId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ChangelistTag_repoId_name_key" ON "ChangelistTag"("repoId", "name");

-- AddForeignKey
ALTER TABLE "OrgUser" ADD CONSTRAINT "OrgUser_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgUser" ADD CONSTRAINT "OrgUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repo" ADD CONSTRAINT "Repo_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepoRole" ADD CONSTRAINT "RepoRole_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepoRole" ADD CONSTRAINT "RepoRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Changelist" ADD CONSTRAINT "Changelist_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Changelist" ADD CONSTRAINT "Changelist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Changelist" ADD CONSTRAINT "Changelist_repoId_parentNumber_fkey" FOREIGN KEY ("repoId", "parentNumber") REFERENCES "Changelist"("repoId", "number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangelistTag" ADD CONSTRAINT "ChangelistTag_repoId_number_fkey" FOREIGN KEY ("repoId", "number") REFERENCES "Changelist"("repoId", "number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangelistTag" ADD CONSTRAINT "ChangelistTag_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileChange" ADD CONSTRAINT "FileChange_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileChange" ADD CONSTRAINT "FileChange_repoId_changelistNumber_fkey" FOREIGN KEY ("repoId", "changelistNumber") REFERENCES "Changelist"("repoId", "number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileCheckout" ADD CONSTRAINT "FileCheckout_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileCheckout" ADD CONSTRAINT "FileCheckout_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

