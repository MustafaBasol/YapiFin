import { AuthShell } from "@/components/auth/auth-shell";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { redirectIfAuthenticated } from "@/lib/auth/guard";
import appConfig from "@/app.config";

export default async function ForgotPasswordPage() {
  await redirectIfAuthenticated();
  return (
    <AuthShell eyebrow={appConfig.name} title="Parolanı sıfırla">
      <ForgotPasswordForm />
    </AuthShell>
  );
}
