import { extractSourceContent } from "./parsers.js";
import { compileAndApplySource } from "./wikiCompiler.js";
import { getProjectOrThrow, getSourceFileOrThrow, loadDb, makeId, mutateDb, nowIso } from "./store.js";
import { withMaterializedSourceFile } from "./storage.js";

export async function processIngestJob(jobId) {
  const snapshot = await loadDb();
  const jobSnapshot = snapshot.ingestJobs.find((item) => item.id === jobId);
  if (!jobSnapshot) return;
  const sourceSnapshot = getSourceFileOrThrow(snapshot, jobSnapshot.sourceFileId);

  try {
    await mutateDb((db) => {
      const job = db.ingestJobs.find((item) => item.id === jobId);
      if (!job) return;
      const sourceFile = getSourceFileOrThrow(db, job.sourceFileId);
      job.status = "processing";
      job.step = sourceFile.category === "audio" ? "transcribe" : "extract";
      job.progress = sourceFile.category === "audio" ? 20 : 30;
      job.attempts = (job.attempts || 0) + 1;
      job.updatedAt = nowIso();
      sourceFile.status = "processing";
      sourceFile.updatedAt = nowIso();
    });

    const { parsedText, transcriptText } = await withMaterializedSourceFile(sourceSnapshot, (localSource) =>
      extractSourceContent(localSource, snapshot)
    );

    await mutateDb(async (db) => {
      const job = db.ingestJobs.find((item) => item.id === jobId);
      if (!job) return;
      const sourceFile = getSourceFileOrThrow(db, job.sourceFileId);
      const project = getProjectOrThrow(db, sourceFile.projectId);
      sourceFile.parsedText = parsedText;
      sourceFile.status = "parsed";
      sourceFile.updatedAt = nowIso();

      if (transcriptText) {
        db.transcripts.push({
          id: makeId("trs"),
          tenantId: project.tenantId || sourceFile.tenantId || "tenant_default",
          projectId: project.id,
          sourceFileId: sourceFile.id,
          text: transcriptText,
          createdAt: nowIso()
        });
      }

      job.step = "compile";
      job.progress = 70;
      job.updatedAt = nowIso();
      const compilationResult = await compileAndApplySource(db, project, sourceFile, parsedText);
      sourceFile.aiSummary = compilationResult.compilation.sourceSummary;
      sourceFile.status = "compiled";
      sourceFile.updatedAt = nowIso();
      job.status = "completed";
      job.step = "completed";
      job.progress = 100;
      job.resultSummary = {
        touchedPages: compilationResult.touchedPages.length,
        changes: compilationResult.changes.length,
        decisions: compilationResult.decisions.length,
        risks: compilationResult.risks.length,
        openQuestions: compilationResult.openQuestions.length
      };
      job.updatedAt = nowIso();
    });
  } catch (error) {
    await mutateDb((db) => {
      const job = db.ingestJobs.find((item) => item.id === jobId);
      if (job) {
        const sourceFile = getSourceFileOrThrow(db, job.sourceFileId);
        sourceFile.status = "failed";
        sourceFile.updatedAt = nowIso();
        job.status = "failed";
        job.error = error.message;
        job.updatedAt = nowIso();
      }
    });
    throw error;
  }
}
