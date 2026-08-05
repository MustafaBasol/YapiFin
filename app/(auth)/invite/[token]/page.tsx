import { AuthShell } from "@/components/auth/auth-shell";
import { AcceptInvitationForm } from "@/components/auth/accept-invitation-form";
import { lookupInvitationByToken } from "@/server/services/invitation-service";
import { ROLE_LABELS } from "@/lib/permissions";
import appConfig from "@/app.config";

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invitation = await lookupInvitationByToken(token);

  if (!invitation || invitation.expired || invitation.accepted) {
    return (
      <AuthShell eyebrow={appConfig.name} title="Davet geçersiz">
        <p className="text-sm text-muted-foreground">
          Bu davet bağlantısı geçersiz, süresi dolmuş veya zaten kullanılmış. Davet gönderen kişiden yeni bir bağlantı isteyin.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell eyebrow={appConfig.name} title="Davete katıl">
      <p className="text-sm text-muted-foreground">
        <strong>{invitation.organizationName}</strong> organizasyonuna <strong>{ROLE_LABELS[invitation.role]}</strong>{" "}
        rolüyle davet edildiniz ({invitation.email}). Hesabınızı oluşturmak için bilgilerinizi girin.
      </p>
      <AcceptInvitationForm token={token} />
    </AuthShell>
  );
}
