import { Router } from 'express';
import { prisma } from '../utils/database';
import { requireUserAuth } from '../auth/auth.middleware';

const router = Router();

const serializeBigInt = (obj: any) => {
  return JSON.parse(
    JSON.stringify(obj, (key, value) =>
      typeof value === 'bigint' ? Number(value) : value
    )
  );
};

// Create a new migration session
router.post('/', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { sourceEmail, destinationEmail, sourceFolderId, destinationFolderId } = req.body;

    if (!sourceEmail || !destinationEmail || !sourceFolderId || !destinationFolderId) {
      return res.status(400).json({ success: false, error: 'Missing required fields for session creation', code: 'INVALID_REQUEST', details: {} });
    }

    const [sourceAccount, destAccount] = await Promise.all([
      prisma.oAuthAccount.findUnique({
        where: { provider_providerAccountId: { provider: 'google-drive-source', providerAccountId: userId } }
      }),
      prisma.oAuthAccount.findUnique({
        where: { provider_providerAccountId: { provider: 'google-drive-destination', providerAccountId: userId } }
      })
    ]);

    const session = await prisma.migrationSession.create({
      data: {
        ownerId: userId,
        sourceEmail,
        destinationEmail,
        sourceAccountId: sourceAccount?.id || null,
        destinationAccountId: destAccount?.id || null,
        sourceFolderId,
        destinationFolderId,
        discoveryStatus: 'PENDING',
        migrationStatus: 'PENDING'
      }
    });

    res.status(200).json({ success: true, session });
  } catch (error: any) {
    console.error('Error creating session:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error', code: 'INTERNAL_ERROR', details: error.message });
  }
});

// Get session details
router.get('/:sessionId', requireUserAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const sessionId = req.params.sessionId as string;

    const session = await prisma.migrationSession.findUnique({
      where: { id: sessionId },
      include: {
        discoveryJob: true,
        migrationJob: true
      }
    });

    if (!session || session.ownerId !== userId) {
      return res.status(404).json({ success: false, error: 'Session not found', code: 'NOT_FOUND', details: {} });
    }

    // Attach scan summary if available
    let scanSummary = null;
    if (session.manifestId) {
      scanSummary = await prisma.scanSummary.findUnique({
         where: { manifestId: session.manifestId },
         include: { mimeStats: true }
      });
    }

    res.status(200).json({ success: true, session: serializeBigInt({ ...session, scanSummary }) });
  } catch (error: any) {
    console.error('Error fetching session:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error', code: 'INTERNAL_ERROR', details: error.message });
  }
});

export default router;
