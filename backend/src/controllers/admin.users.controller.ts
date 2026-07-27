import { Request, Response } from 'express';
import { prisma } from '../utils/database';
import bcrypt from 'bcrypt';

export async function getUsers(req: Request, res: Response) {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        isActive: true,
        createdAt: true,
        lastLogin: true,
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(users);
  } catch (error) {
    console.error('Failed to get users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createUser(req: Request, res: Response) {
  try {
    const { name, email, role, password } = req.body;
    
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase() }
    });

    if (existingUser) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        name,
        email: email.toLowerCase(),
        role: role || 'USER',
        passwordHash,
        status: 'ACTIVE',
        isActive: true,
        createdBy: (req as any).user?.id
      },
      select: { id: true, name: true, email: true, role: true }
    });

    res.status(201).json(newUser);
  } catch (error) {
    console.error('Failed to create user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateUser(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { name, role, status, isActive, password } = req.body;
    
    const dataToUpdate: any = {};
    if (name) dataToUpdate.name = name;
    if (role) dataToUpdate.role = role;
    if (status) dataToUpdate.status = status;
    if (isActive !== undefined) dataToUpdate.isActive = isActive;
    if (password) {
      dataToUpdate.passwordHash = await bcrypt.hash(password, 10);
    }

    const updatedUser = await prisma.user.update({
      where: { id: id as string },
      data: dataToUpdate,
      select: { id: true, name: true, email: true, role: true, status: true, isActive: true }
    });

    res.json(updatedUser);
  } catch (error) {
    console.error('Failed to update user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteUser(req: Request, res: Response) {
  try {
    const { id } = req.params;
    
    // Prevent self-deletion if needed
    if ((req as any).user?.id === id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }

    await prisma.user.delete({ where: { id: id as string } });
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Left for backwards compatibility
export async function inviteAdmin(req: Request, res: Response) {
  try {
    const currentUser = (req as any).user;
    
    if (currentUser.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Only SUPER_ADMIN can invite new administrators' });
    }

    const { name, email, role, password } = req.body;

    if (!name || !email || !role || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

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

    const passwordHash = await bcrypt.hash(password, 12);

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
