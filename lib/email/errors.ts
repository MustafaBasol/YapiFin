import { createHash } from "node:crypto";

export type MailFailureCategory =
  | "CONFIGURATION"
  | "AUTHENTICATION"
  | "CONNECTION_REFUSED"
  | "CONNECTION_TIMEOUT"
  | "GREETING_TIMEOUT"
  | "SOCKET_TIMEOUT"
  | "TLS_CERTIFICATE"
  | "RECIPIENT_REJECTED"
  | "TEMPORARY_PROVIDER"
  | "PERMANENT_PROVIDER"
  | "UNKNOWN";

export interface ClassifiedMailError {
  category: MailFailureCategory;
  /** Aynı isteğin gövdesinde otomatik yeniden denemek için değil — yalnızca gelecekteki bir kuyruk/retry mekanizması için sınıflandırma amaçlıdır. */
  retryable: boolean;
  smtpStatusCode: number | null;
}

const RETRYABLE: Record<MailFailureCategory, boolean> = {
  CONFIGURATION: false,
  AUTHENTICATION: false,
  CONNECTION_REFUSED: true,
  CONNECTION_TIMEOUT: true,
  GREETING_TIMEOUT: true,
  SOCKET_TIMEOUT: true,
  TLS_CERTIFICATE: false,
  RECIPIENT_REJECTED: false,
  TEMPORARY_PROVIDER: true,
  PERMANENT_PROVIDER: false,
  UNKNOWN: false,
};

interface NodemailerLikeError {
  code?: string;
  command?: string;
  responseCode?: number;
  recipient?: string;
  message?: string;
}

const CERTIFICATE_MESSAGE_PATTERN = /certificate|self[- ]signed|cert has expired|unable to verify|ssl routines/i;

/**
 * nodemailer/smtp-connection sabit `err.code` değerlerini (EAUTH, ETIMEDOUT,
 * ESOCKET, ...) döndürür; ancak bağlantı-zamanlaması hataları (connection /
 * greeting / socket timeout) hepsi aynı `ETIMEDOUT` kodunu ve `CONN` komutunu
 * paylaşır — nodemailer bunları yalnızca `err.message` metniyle ayırt eder
 * ("Connection timeout" / "Greeting never received" / diğer her şey socket
 * inaktivite zaman aşımıdır). Aynı şekilde TLS sertifika hataları ilk güvenli
 * bağlantıda (`secure: true`, port 465) `ESOCKET` koduna sarılır (Node'un tls
 * soketi hatasını nodemailer sarmalar) — bu yüzden mesaj metni de kontrol
 * edilir.
 */
function classify(err: NodemailerLikeError): MailFailureCategory {
  const code = err.code;
  const message = err.message ?? "";

  if (code === "EAUTH") return "AUTHENTICATION";

  if (code === "ETIMEDOUT") {
    if (message.includes("Connection timeout")) return "CONNECTION_TIMEOUT";
    if (message.includes("Greeting never received")) return "GREETING_TIMEOUT";
    return "SOCKET_TIMEOUT";
  }

  if (code === "ETLS") return "TLS_CERTIFICATE";

  if (code === "ESOCKET" || code === "ECONNECTION") {
    if (/ECONNREFUSED/.test(message)) return "CONNECTION_REFUSED";
    if (CERTIFICATE_MESSAGE_PATTERN.test(message)) return "TLS_CERTIFICATE";
    return "CONNECTION_REFUSED";
  }

  if (code === "ECONFIG") return "CONFIGURATION";

  if (code === "EENVELOPE") {
    if (err.command === "RCPT TO" || typeof err.recipient === "string") return "RECIPIENT_REJECTED";
    const status = err.responseCode;
    if (typeof status === "number") {
      if (status >= 400 && status < 500) return "TEMPORARY_PROVIDER";
      if (status >= 500) return "PERMANENT_PROVIDER";
    }
    return "PERMANENT_PROVIDER";
  }

  if (typeof err.responseCode === "number") {
    if (err.responseCode >= 400 && err.responseCode < 500) return "TEMPORARY_PROVIDER";
    if (err.responseCode >= 500) return "PERMANENT_PROVIDER";
  }

  return "UNKNOWN";
}

export function classifyMailError(err: unknown): ClassifiedMailError {
  const candidate = (err && typeof err === "object" ? err : {}) as NodemailerLikeError;
  const category = classify(candidate);
  return {
    category,
    retryable: RETRYABLE[category],
    smtpStatusCode: typeof candidate.responseCode === "number" ? candidate.responseCode : null,
  };
}

/** Loglarda tam e-posta adresi tutmamak için tersine çevrilemez, tutarlı bir kısa özet üretir. */
export function maskRecipient(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16);
}
