import { Request, Response } from 'express';
import { prisma } from '../utils/database';
import bcrypt from 'bcrypt';

export async function inviteAdmin(req: Request, res: Response) {
  try {
    const currentUser = req.user as any;
    
    // Only SUPER_ADMIN can invite admins
    if (currentUser.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Only SUPER_ADMIN can invite new administrators' });
    }

    const { name, email, role, password } = req.body;

    if (!name || !email || !role || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // A SUPER_ADMIN cannot invite another SUPER_ADMIN
    if (role === 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Cannot create another SUPER_ADMIN' });
    }
    
    if (role !== 'ADMIN' && role !== 'SUPERVISOR') {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase() }
    });

    if (existingUser) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }

    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const newUser = await prisma.user.create({
      data: {
        name,
        email: email.toLowerCase(),
        role,
        passwordHash,
        status: 'ACTIVE',
        isActive: true,
        createdBy: currentUser.id
      }
    });

    // Write audit log
    await prisma.auditLog.create({
      data: {
        userId: currentUser.id,
        action: 'INVITE_ADMIN',
        description: `Invited ${role} (${email})`,
        ip: req.ip
      }
    });

    res.status(201).json({ success: true, user: { id: newUser.id, name: newUser.name, email: newUser.email, role: newUser.role }});
  } catch (error) {
    console.error('Failed to invite admin:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
