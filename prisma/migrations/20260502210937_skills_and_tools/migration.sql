-- CreateEnum
CREATE TYPE "AiToolSource" AS ENUM ('BUILTIN', 'CUSTOM_HTTP');

-- CreateTable
CREATE TABLE "ai_tools" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "source" "AiToolSource" NOT NULL,
    "parameters" JSONB NOT NULL,
    "http_method" TEXT,
    "http_url" TEXT,
    "http_headers" JSONB,
    "http_body_template" TEXT,
    "response_map" JSONB,
    "timeout_ms" INTEGER NOT NULL DEFAULT 15000,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "ai_tools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_skills" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT,
    "prompt_instructions" TEXT,
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "ai_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_skill_versions" (
    "id" TEXT NOT NULL,
    "skill_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT,
    "prompt_instructions" TEXT,
    "tool_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "changed_by_id" TEXT,
    "change_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_skill_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_skill_tools" (
    "skill_id" TEXT NOT NULL,
    "tool_id" TEXT NOT NULL,

    CONSTRAINT "ai_skill_tools_pkey" PRIMARY KEY ("skill_id","tool_id")
);

-- CreateTable
CREATE TABLE "ai_agent_skills" (
    "agent_id" TEXT NOT NULL,
    "skill_id" TEXT NOT NULL,

    CONSTRAINT "ai_agent_skills_pkey" PRIMARY KEY ("agent_id","skill_id")
);

-- CreateTable
CREATE TABLE "ai_agent_tools" (
    "agent_id" TEXT NOT NULL,
    "tool_id" TEXT NOT NULL,

    CONSTRAINT "ai_agent_tools_pkey" PRIMARY KEY ("agent_id","tool_id")
);

-- CreateIndex
CREATE INDEX "idx_tool_org" ON "ai_tools"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_tools_organization_id_name_key" ON "ai_tools"("organization_id", "name");

-- CreateIndex
CREATE INDEX "idx_skill_org" ON "ai_skills"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_skills_organization_id_name_key" ON "ai_skills"("organization_id", "name");

-- CreateIndex
CREATE INDEX "idx_skill_version_skill" ON "ai_skill_versions"("skill_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_skill_versions_skill_id_version_key" ON "ai_skill_versions"("skill_id", "version");

-- AddForeignKey
ALTER TABLE "ai_tools" ADD CONSTRAINT "ai_tools_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_skills" ADD CONSTRAINT "ai_skills_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_skill_versions" ADD CONSTRAINT "ai_skill_versions_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "ai_skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_skill_tools" ADD CONSTRAINT "ai_skill_tools_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "ai_skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_skill_tools" ADD CONSTRAINT "ai_skill_tools_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "ai_tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_skills" ADD CONSTRAINT "ai_agent_skills_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_skills" ADD CONSTRAINT "ai_agent_skills_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "ai_skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_tools" ADD CONSTRAINT "ai_agent_tools_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_tools" ADD CONSTRAINT "ai_agent_tools_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "ai_tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
