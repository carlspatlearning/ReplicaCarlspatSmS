-- Resources may optionally be grouped by subject. Existing rows remain valid.
ALTER TABLE "Resource" ADD COLUMN "subjectId" TEXT;

CREATE INDEX "Resource_subjectId_idx" ON "Resource"("subjectId");

ALTER TABLE "Resource" ADD CONSTRAINT "Resource_subjectId_fkey"
FOREIGN KEY ("subjectId") REFERENCES "Subject"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
