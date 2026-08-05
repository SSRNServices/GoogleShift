import { updateJobStatus, logJobEvent, updateJobProgress, prisma } from '../utils/database';

export class VerificationService {
  public static async execute(jobId: string, manifestId: string) {
    console.log(`\n[STATE] VERIFYING\nMigration: ${jobId} | Manifest: ${manifestId}\nReason: Consistency checks`);
    await logJobEvent(jobId, `[STATE] VERIFYING`);
    await updateJobStatus(jobId, 'VERIFYING');
    await updateJobProgress(jobId, { status: 'verifying', currentAction: 'Verifying files...', event: 'VERIFY_STARTED' });

    // Ensure all items are SUCCESS or FAILED (no PENDING/QUEUED)
    const stuckItems = await prisma.migrationManifest.count({
      where: {
         jobId: manifestId,
         status: { in: ['PENDING', 'QUEUED', 'DOWNLOADING', 'UPLOADING'] }
      }
    });

    if (stuckItems > 0) {
       console.warn(`[VerificationService] Found ${stuckItems} stuck items. Marking as FAILED.`);
       await prisma.migrationManifest.updateMany({
         where: {
            jobId: manifestId,
            status: { in: ['PENDING', 'QUEUED', 'DOWNLOADING', 'UPLOADING'] }
         },
         data: { status: 'FAILED' }
       });
    }

    const completed = await prisma.migrationManifest.count({
       where: { jobId: manifestId, status: 'SUCCESS', isFolder: false }
    });
    
    const failed = await prisma.migrationManifest.count({
       where: { jobId: manifestId, status: 'FAILED', isFolder: false }
    });

    const finalStatus = failed > 0 ? 'completed_with_errors' : 'completed';

    await updateJobProgress(jobId, { 
       completedFiles: completed,
       failedFiles: failed,
       event: 'VERIFY_COMPLETED',
       currentAction: `Verification complete. Status: ${finalStatus}`,
       status: finalStatus
    });

    console.log(`[VerificationService] Verification complete. Status: ${finalStatus}. Completed: ${completed}, Failed: ${failed}`);
  }
}
