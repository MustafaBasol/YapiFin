import { AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/login-form";
import { redirectIfAuthenticated } from "@/lib/auth/guard";
import appConfig from "@/app.config";

export default async function LoginPage() {
  await redirectIfAuthenticated();
  return (
    <AuthShell eyebrow={appConfig.name} title="Tekrar hoş geldin">
      <LoginForm />
    </AuthShell>
  );
}
