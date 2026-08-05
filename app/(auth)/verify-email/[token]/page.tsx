import Link from "next/link";
import { CheckCircle2, XCircle } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { verifyEmail } from "@/server/services/auth-service";
import appConfig from "@/app.config";

export default async function VerifyEmailPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  let error: string | null = null;
  try {
    await verifyEmail(token);
  } catch (err) {
    error = err instanceof Error ? err.message : "Doğrulama başarısız oldu";
  }

  return (
    <AuthShell eyebrow={appConfig.name} title="E-posta doğrulama">
      <div className="flex flex-col items-center gap-4 text-center">
        {error ? (
          <>
            <XCircle className="h-10 w-10 text-destructive" />
            <p className="text-sm text-muted-foreground">{error}</p>
          </>
        ) : (
          <>
            <CheckCircle2 className="h-10 w-10 text-success" />
            <p className="text-sm text-muted-foreground">E-posta adresiniz doğrulandı.</p>
          </>
        )}
        <Link href="/dashboard" className="w-full">
          <Button className="w-full">Panele git</Button>
        </Link>
      </div>
    </AuthShell>
  );
}
