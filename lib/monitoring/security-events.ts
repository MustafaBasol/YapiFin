import { captureSecurityEvent } from "@/lib/monitoring";
import { shouldForwardToRemote } from "@/lib/monitoring/sampler";

/**
 * YF-512 — Güvenlik olayı türü başına örnekleme (sampling) bütçeleri.
 * Değerler 💡 başlangıç önerisidir (docs/operations/MONITORING_RUNBOOK.md ile
 * aynı üslup) — gerçek production trafiği gözlemlendikten sonra kalibre
 * edilmelidir. Amaç: sürmekte olan tek bir olayın (ör. sürekli DB kesintisi,
 * bir IP'den kaba kuvvet denemesi) her tekrarında ayrı bir uzak APM olayı
 * üretmemek — yerel yapılandırılmış log HER ZAMAN yazılır (çağıran taraflarda,
 * bu modülden bağımsız), yalnızca uzak iletim burada sınırlanır.
 */
const RATE_LIMIT_WINDOW_MS = 5 * 60_000;
const RATE_LIMIT_MAX_PER_WINDOW = 5;

const FAILED_LOGIN_WINDOW_MS = 5 * 60_000;
const FAILED_LOGIN_MAX_PER_WINDOW = 5;

const SMTP_FAILURE_WINDOW_MS = 5 * 60_000;
const SMTP_FAILURE_MAX_PER_WINDOW = 5;

const DB_FAILURE_WINDOW_MS = 60_000;
const DB_FAILURE_MAX_PER_WINDOW = 1;

export function recordRateLimitSecurityEvent(input: {
  policy: string;
  outcome: "blocked" | "store_unavailable";
  source: "redis" | "memory-fallback";
  subjectHash: string;
}): void {
  const key = `rate_limit:${input.policy}:${input.outcome}`;
  const forward = shouldForwardToRemote(key, { windowMs: RATE_LIMIT_WINDOW_MS, maxPerWindow: RATE_LIMIT_MAX_PER_WINDOW });
  captureSecurityEvent({
    type: "rate_limit",
    result: input.outcome,
    subjectHash: input.subjectHash,
    meta: { policy: input.policy, source: input.source },
    forward,
  });
}

export function recordFailedLoginSecurityEvent(input: { route: string; subjectHash: string }): void {
  const key = `failed_login:${input.subjectHash}`;
  const forward = shouldForwardToRemote(key, {
    windowMs: FAILED_LOGIN_WINDOW_MS,
    maxPerWindow: FAILED_LOGIN_MAX_PER_WINDOW,
  });
  captureSecurityEvent({
    type: "failed_login",
    result: "invalid_credentials",
    route: input.route,
    subjectHash: input.subjectHash,
    forward,
  });
}

export function recordSmtpFailureSecurityEvent(input: {
  category: string;
  retryable: boolean;
  recipientHash: string;
}): void {
  const key = `smtp_failure:${input.category}`;
  const forward = shouldForwardToRemote(key, {
    windowMs: SMTP_FAILURE_WINDOW_MS,
    maxPerWindow: SMTP_FAILURE_MAX_PER_WINDOW,
  });
  captureSecurityEvent({
    type: "smtp_failure",
    result: input.category,
    subjectHash: input.recipientHash,
    meta: { retryable: input.retryable },
    forward,
  });
}

export function recordDatabaseFailureSecurityEvent(input: { category: string; source: string }): void {
  const key = `db_failure:${input.source}:${input.category}`;
  const forward = shouldForwardToRemote(key, { windowMs: DB_FAILURE_WINDOW_MS, maxPerWindow: DB_FAILURE_MAX_PER_WINDOW });
  captureSecurityEvent({
    type: "db_failure",
    result: input.category,
    meta: { source: input.source },
    forward,
  });
}
