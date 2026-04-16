-- CreateTable
CREATE TABLE "DailyMetrics" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "activeTrials" INTEGER NOT NULL,
    "activeSubscriptions" INTEGER NOT NULL,
    "delinquentSubs" INTEGER NOT NULL,
    "totalUsers" INTEGER NOT NULL,
    "activeOrgs" INTEGER NOT NULL,
    "activeRepos" INTEGER NOT NULL,
    "orgUsersHistogram" JSONB NOT NULL,
    "reposPerOrgHistogram" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyMetrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyMetrics_date_key" ON "DailyMetrics"("date");

