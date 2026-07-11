-- Drop the EULA/privacy-policy acceptance concept. The columns that gated
-- "instance configured" are renamed to setupCompleted* so existing instances
-- stay configured.
ALTER TABLE "InstanceSettings" RENAME COLUMN "eulaAcceptedAt" TO "setupCompletedAt";
ALTER TABLE "InstanceSettings" RENAME COLUMN "eulaAcceptedBy" TO "setupCompletedBy";
