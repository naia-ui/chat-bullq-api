-- Pipeline de caso vinculado ao agente (ex: "Justine Trabalhista" -> pipeline
-- "Atendimento Trabalhista"). Null = usa o pipeline padrão da org (funil de
-- leads) como fallback.
ALTER TABLE "ai_agents" ADD COLUMN "pipeline_id" TEXT;

CREATE INDEX "idx_ai_agent_pipeline" ON "ai_agents"("pipeline_id");

ALTER TABLE "ai_agents"
  ADD CONSTRAINT "ai_agents_pipeline_id_fkey"
  FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
