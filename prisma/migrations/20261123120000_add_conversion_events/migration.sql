-- Funil de captação, Fase 6: devolver a conversão à plataforma de anúncio
-- quando o card chega à etapa de contrato assinado.
--
-- Duas partes: o gatilho novo do motor de automação (CARD_STAGE_CHANGED) e
-- a fila de conversões, com unicidade por (card, etapa, plataforma) — é ela
-- que impede a mesma conversão de sair duas vezes.
--
-- PostgreSQL 16: ADD VALUE dentro da transação da migration é permitido
-- porque o valor novo não é usado nesta mesma migration.

-- AlterEnum
ALTER TYPE "AutomationTrigger" ADD VALUE IF NOT EXISTS 'CARD_STAGE_CHANGED';

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ConversionPlatform" AS ENUM ('META', 'GOOGLE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ConversionStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'FAILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "conversion_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "card_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "platform" "ConversionPlatform" NOT NULL,
    "event_name" TEXT NOT NULL,
    "stage_id" TEXT NOT NULL,
    "stage_label" TEXT NOT NULL,
    "match_kind" TEXT NOT NULL,
    "match_value" TEXT NOT NULL,
    "campaign_code" TEXT,
    "value" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "release_at" TIMESTAMP(3) NOT NULL,
    "status" "ConversionStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "dry_run" BOOLEAN NOT NULL DEFAULT true,
    "sent_at" TIMESTAMP(3),
    "response" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversion_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "uq_conversion_card_stage_platform" ON "conversion_events"("card_id", "stage_id", "platform");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_conversion_due" ON "conversion_events"("status", "release_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_conversion_org_time" ON "conversion_events"("organization_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
