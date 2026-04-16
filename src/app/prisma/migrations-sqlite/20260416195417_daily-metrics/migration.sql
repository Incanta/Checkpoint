-- CreateTable
CREATE TABLE "DailyMetrics" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" DATETIME NOT NULL,
    "activeTrials" INTEGER NOT NULL,
    "activeSubscriptions" INTEGER NOT NULL,
    "delinquentSubs" INTEGER NOT NULL,
    "totalUsers" INTEGER NOT NULL,
    "activeOrgs" INTEGER NOT NULL,
    "activeRepos" INTEGER NOT NULL,
    "orgUsersHistogram" JSONB NOT NULL,
    "reposPerOrgHistogram" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyMetrics_date_key" ON "DailyMetrics"("date");

