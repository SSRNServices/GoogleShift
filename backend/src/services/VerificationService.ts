import { updateJobStatus, logJobEvent, updateJobProgress, prisma } from '../utils/database';

export class VerificationService {
  public static async execute(jobId: string, manifestId: string) {
    console.log(`\n[STATE] VERIFYING\nMigration: ${jobId} | Manifest: ${manifestId}\nReason: Consistency checks`);
    await logJobEvent(jobId, `[STATE] VERIFYING`);
    await updateJobStatus(jobId, 'VERIFYING');
    await updateJobProgress(jobId, { status: 'verifying', currentAction: 'Verifying files...', event: 'VERIFY_STARTED' });

    // Ensure all items are SUCCESS or FAILED (no PENDING/QUEUED)
    const { ManifestStorage } = await import('../utils/ManifestStorage');
    const stuckItems = await ManifestStorage.countItems(manifestId, {
      statusIn: ['PENDING', 'QUEUED', 'DOWNLOADING', 'UPLOADING']
    });

    if (stuckItems > 0) {
       console.warn(`[VerificationService] Found ${stuckItems} stuck items. Marking as FAILED.`);
       await ManifestStorage.updateManyStatus(
         manifestId,
         { statusIn: ['PENDING', 'QUEUED', 'DOWNLOADING', 'UPLOADING'] },
         'FAILED'
       );
    }

    const completed = await ManifestStorage.countItems(manifestId, {
       status: 'SUCCESS',
       isFolder: false
    });
    
    const failed = await ManifestStorage.countItems(manifestId, {
       status: 'FAILED',
       isFolder: false
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
