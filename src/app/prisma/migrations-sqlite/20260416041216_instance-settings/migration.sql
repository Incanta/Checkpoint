-- CreateTable
CREATE TABLE "InstanceSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "eulaAcceptedAt" DATETIME,
    "eulaAcceptedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

