"use client";

import { useActionState } from "react";
import { MailWarning } from "lucide-react";
import { resendVerificationAction } from "@/app/actions/auth";
import { initialActionState } from "@/lib/action-state";

export function VerificationBanner() {
  const [state, formAction, pending] = useActionState(async () => resendVerificationAction(), initialActionState);

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-warning/30 bg-warning/10 px-5 py-2.5 text-[13px] text-warning-foreground lg:px-8">
      <MailWarning className="h-4 w-4 shrink-0" />
      <span>E-posta adresiniz henüz doğrulanmadı.</span>
      <form action={formAction} className="ml-auto">
        <button
          type="submit"
          disabled={pending}
          className="font-semibold underline underline-offset-2 disabled:opacity-60 cursor-pointer"
        >
          {pending ? "Gönderiliyor…" : state?.success ?? "Doğrulama e-postasını tekrar gönder"}
        </button>
      </form>
    </div>
  );
}
