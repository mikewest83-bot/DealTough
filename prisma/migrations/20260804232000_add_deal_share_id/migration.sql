-- AlterTable
ALTER TABLE "Deal" ADD COLUMN     "shareId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Deal_shareId_key" ON "Deal"("shareId");
