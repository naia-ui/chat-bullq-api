-- Watermark pro AiRunHealthCron: desde quando a org está numa sequência
-- de execuções de IA 100% falhando, e quando foi o último alerta mandado
-- (cooldown, mesmo padrão do ZappfyConnectionHealthCron).
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "ai_failure_streak_since" TIMESTAMP(3);
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "ai_failure_alert_last_sent_at" TIMESTAMP(3);
