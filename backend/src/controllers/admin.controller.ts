import { Request, Response } from 'express';
import { prisma } from '../utils/database';

export async function getDashboardMetrics(req: Request, res: Response) {
  try {
    const totalUsers = await prisma.user.count();
    const activeMigrations = await prisma.migrationJob.count({
      where: { state: 'RUNNING' }
    });
    const completedJobs = await prisma.migrationJob.count({
      where: { state: 'COMPLETED' }
    });
    
    // Sum transferred bytes
    const aggregations = await prisma.migrationJob.aggregate({
      _sum: {
        transferredBytes: true
      },
      where: {
        state: 'COMPLETED'
      }
    });

    const totalBytesMigrated = aggregations._sum.transferredBytes ? aggregations._sum.transferredBytes.toString() : '0';

    res.json({
      totalUsers,
      activeMigrations,
      completedJobs,
      totalBytesMigrated
    });
  } catch (error) {
    console.error('Failed to fetch dashboard metrics:', error);
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
}
