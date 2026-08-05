export function FormAlert({ error, success }: { error?: string; success?: string }) {
  if (!error && !success) return null;
  return (
    <p
      role="alert"
      className={
        error
          ? "rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          : "rounded-lg bg-success/10 px-3 py-2 text-sm text-success"
      }
    >
      {error ?? success}
    </p>
  );
}
