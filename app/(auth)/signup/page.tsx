import { AuthShell } from "@/components/auth/auth-shell";
import { SignupForm } from "@/components/auth/signup-form";
import { redirectIfAuthenticated } from "@/lib/auth/guard";
import appConfig from "@/app.config";

export default async function SignupPage() {
  await redirectIfAuthenticated();
  return (
    <AuthShell eyebrow={appConfig.name} title="Firma kaydı oluştur" wide>
      <SignupForm />
    </AuthShell>
  );
}
