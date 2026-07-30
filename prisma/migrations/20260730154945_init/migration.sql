-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "askingPrice" DOUBLE PRECISION NOT NULL,
    "condition" TEXT,
    "recommendation" JSONB NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'from-listing',
    "rawListingText" TEXT,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Deal_createdAt_idx" ON "Deal"("createdAt");
