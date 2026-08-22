-- Número de WhatsApp por agente pro ping interno de handoff (ex: quem
-- está de plantão trabalhista hoje). Somado aos números fixos de
-- HANDOFF_ALERT_WHATSAPP_NUMBERS (env), não substitui.
ALTER TABLE "ai_agents" ADD COLUMN "handoff_alert_phone" TEXT;
