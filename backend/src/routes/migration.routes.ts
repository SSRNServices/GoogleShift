import { Router } from 'express';
import { migrationService } from '../services/MigrationService';

const router = Router();

router.post('/start', async (req, res) => {
  console.log('[Backend] MIGRATION START RECEIVED');
  console.log('Payload:', req.body);

  try {
    const job = await migrationService.startMigrationJob(req.body);
    res.status(200).json(job);
  } catch (error: any) {
    console.error('Error starting migration:', error);
    res.status(500).json({ error: error.message || 'Failed to start migration' });
  }
});

export default router;
