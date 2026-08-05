import { AuthShell } from "@/components/auth/auth-shell";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { redirectIfAuthenticated } from "@/lib/auth/guard";
import appConfig from "@/app.config";

export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  await redirectIfAuthenticated();
  const { token } = await params;
  return (
    <AuthShell eyebrow={appConfig.name} title="Yeni parola belirle">
      <ResetPasswordForm token={token} />
    </AuthShell>
  );
}
