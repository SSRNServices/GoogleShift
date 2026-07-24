import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import { API_URL } from '../../config/api';

export default function Users() {
  const [showInviteModal, setShowInviteModal] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">User Management</h1>
        <Button onClick={() => setShowInviteModal(true)}>Invite Admin</Button>
      </div>
      
      <Card>
        <CardHeader>
          <CardTitle>System Administrators</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            Feature in development. Use the Invite Admin button to create new administrators.
          </div>
        </CardContent>
      </Card>
      
      {showInviteModal && (
        <InviteAdminModal onClose={() => setShowInviteModal(false)} />
      )}
    </div>
  );
}

function InviteAdminModal({ onClose }: { onClose: () => void }) {
  const [formData, setFormData] = useState({ name: '', email: '', role: 'ADMIN', password: '' });
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    
    try {
      const res = await fetch(`${API_URL}/api/admin/users/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
        credentials: 'include'
      });
      
      if (!res.ok) throw new Error(await res.text());
      
      alert('Admin successfully invited!');
      onClose();
    } catch (err) {
      alert('Failed to invite admin: ' + err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
      <Card className="w-full max-w-md shadow-2xl">
        <CardHeader>
          <CardTitle>Invite Administrator</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Name</label>
              <input type="text" required className="w-full rounded-md border p-2 bg-background" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Email</label>
              <input type="email" required className="w-full rounded-md border p-2 bg-background" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Role</label>
              <select className="w-full rounded-md border p-2 bg-background" value={formData.role} onChange={e => setFormData({...formData, role: e.target.value})}>
                <option value="ADMIN">ADMIN</option>
                <option value="SUPERVISOR">SUPERVISOR</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Temporary Password</label>
              <input type="password" required className="w-full rounded-md border p-2 bg-background" minLength={12} value={formData.password} onChange={e => setFormData({...formData, password: e.target.value})} />
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={submitting}>Invite</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
