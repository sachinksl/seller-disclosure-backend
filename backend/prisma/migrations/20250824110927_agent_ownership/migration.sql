-- AlterTable
ALTER TABLE "public"."Property" ADD COLUMN     "agentId" TEXT;

-- CreateIndex
CREATE INDEX "Property_orgId_agentId_idx" ON "public"."Property"("orgId", "agentId");

-- CreateIndex
CREATE INDEX "Property_orgId_sellerId_idx" ON "public"."Property"("orgId", "sellerId");

-- AddForeignKey
ALTER TABLE "public"."Property" ADD CONSTRAINT "Property_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
