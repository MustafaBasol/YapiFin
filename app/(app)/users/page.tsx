import { requireRole } from "@/lib/auth/guard";
import { listUsers } from "@/server/services/user-service";
import { listPendingInvitations } from "@/server/services/invitation-service";
import { listProjectsForUser } from "@/server/services/project-service";
import { InviteUserForm } from "@/components/app/invite-user-form";
import { UsersTable } from "@/components/app/users-table";
import { PendingInvitationsTable } from "@/components/app/pending-invitations-table";

export default async function UsersPage() {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const [users, invitations, projects] = await Promise.all([
    listUsers(actor),
    listPendingInvitations(actor),
    listProjectsForUser(actor),
  ]);

  return (
    <div className="mx-auto max-w-5xl animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Kullanıcılar</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Organizasyon kullanıcılarını ve davetlerini yönetin.</p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
        <h2 className="font-display text-[15px] font-semibold tracking-tight">Kullanıcı davet et</h2>
        <div className="mt-4">
          <InviteUserForm projects={projects.map((p) => ({ id: p.id, name: p.name }))} />
        </div>
      </div>

      <div>
        <h2 className="mb-2 font-display text-[15px] font-semibold tracking-tight">Kullanıcılar</h2>
        <UsersTable
          currentUserId={actor.id}
          currentUserRole={actor.role}
          users={users.map((u) => ({
            id: u.id,
            firstName: u.firstName,
            lastName: u.lastName,
            email: u.email,
            role: u.role,
            status: u.status,
            projectCount: u.projectMemberships.length,
          }))}
        />
      </div>

      {invitations.length > 0 && (
        <div>
          <h2 className="mb-2 font-display text-[15px] font-semibold tracking-tight">Bekleyen davetler</h2>
          <PendingInvitationsTable
            invitations={invitations.map((i) => ({
              id: i.id,
              email: i.email,
              role: i.role,
              expiresAt: i.expiresAt.toISOString(),
            }))}
          />
        </div>
      )}
    </div>
  );
}
