import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { canCreateExpense } from "@/lib/permissions";
import { forbidden, notFound, conflict, ServiceError } from "@/server/services/errors";
import { getProjectForUser } from "@/server/services/project-service";
import { createExpense } from "@/server/services/transaction-service";
import {
  nullDocumentExtractionProvider,
  emptyExtractionResult,
  type DocumentExtractionProvider,
  type DocumentExtractionResult,
} from "@/server/services/document-extraction/provider";
import type { SessionUser } from "@/lib/auth/session";
import type { UploadDocumentInput, ConfirmDocumentExtractionInput } from "@/lib/validation/document-extraction";
import type { Prisma } from "@prisma/client";

/**
 * YF-601 — OCR/belge çıkarım servis katmanı.
 *
 * KRİTİK İŞ KURALI: bu dosyanın hiçbir fonksiyonu doğrudan bir
 * FinancialTransaction/Settlement/AccountMovement oluşturmaz, onaylamaz veya
 * değiştirmez. Tek finansal mutasyon noktası `confirmDocumentExtraction`
 * içinde, insan onayından SONRA çağrılan mevcut `createExpense`'tir — bu
 * servis onun iş kurallarını (tenant/rol/proje/kategori/tedarikçi doğrulama,
 * KDV hesaplama, audit log) hiçbir şekilde tekrarlamaz.
 */

const MAX_UPLOAD_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB — tipik taranmış fatura/fiş için yeterli, DB bytea şişmesini sınırlar.

type SniffedMimeType = "application/pdf" | "image/jpeg" | "image/png";

/**
 * Dosya türünü İSTEMCİDEN GELEN `file.type`/dosya adı uzantısına GÜVENMEDEN,
 * yalnızca ilk baytlardaki (magic number) imzaya bakarak belirler (bkz. görev
 * talimatı "do not trust filename extensions"). Tanınmayan/desteklenmeyen her
 * içerik güvenle reddedilir.
 */
function sniffMimeType(buffer: Buffer): SniffedMimeType | null {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-") {
    return "application/pdf";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  return null;
}

/** Denetim/gösterim amaçlı serbest metin dosya adı — hiçbir zaman bir depolama yolu/anahtarı olarak kullanılmaz (dosya diskte değil, DB'de bytea olarak saklanır). */
function sanitizeDisplayFileName(rawName: string): string {
  const trimmed = rawName.trim().slice(0, 180);
  return trimmed.length > 0 ? trimmed : "belge";
}

export interface UploadAndExtractDocumentInput extends UploadDocumentInput {
  fileName: string;
  /** İstemcinin bildirdiği MIME türü KASITLI OLARAK kabul edilmez/kullanılmaz — depolanan tür her zaman `sniffMimeType` ile baytlardan belirlenir. */
  buffer: Buffer;
}

async function assertUploadAuthorized(actor: SessionUser, projectId: string | undefined) {
  // Bu taslak yalnızca gider onayına akabildiğinden yetki kapısı olarak
  // mevcut `canCreateExpense` yeniden kullanılır — yeni bir izin kuralı
  // İCAT EDİLMEZ (bkz. docs/SECURITY.md §1, lib/permissions.ts).
  if (!canCreateExpense(actor.role)) throw forbidden();

  if (actor.role === "PROJECT_MANAGER") {
    if (!projectId) {
      throw forbidden("Proje yöneticisi yalnızca bir projeye bağlı belge yükleyebilir");
    }
  }

  if (projectId) {
    // `getProjectForUser` tenant + PROJECT_MANAGER üyelik kapsamını zaten
    // fail-closed doğrular (cross-tenant/atanmamış proje -> NOT_FOUND, veri
    // sızıntısı yok) — burada tekrarlanmaz.
    await getProjectForUser(actor, projectId);
  }
}

export async function uploadAndExtractDocument(
  actor: SessionUser,
  input: UploadAndExtractDocumentInput,
  provider: DocumentExtractionProvider = nullDocumentExtractionProvider,
) {
  await assertUploadAuthorized(actor, input.projectId);

  if (input.buffer.length === 0) {
    throw new ServiceError("Boş dosya yüklenemez");
  }
  if (input.buffer.length > MAX_UPLOAD_SIZE_BYTES) {
    throw new ServiceError("Dosya boyutu 8 MB sınırını aşıyor");
  }

  const sniffed = sniffMimeType(input.buffer);
  if (!sniffed) {
    throw new ServiceError("Desteklenmeyen dosya türü. Yalnızca PDF, JPEG veya PNG yükleyebilirsiniz.");
  }

  const fileName = sanitizeDisplayFileName(input.fileName);

  const created = await db.$transaction(async (tx) => {
    const record = await tx.documentExtraction.create({
      data: {
        organizationId: actor.organizationId,
        projectId: input.projectId ?? null,
        uploadedById: actor.id,
        fileName,
        mimeType: sniffed,
        sizeBytes: input.buffer.length,
        // `Buffer`'ın `ArrayBufferLike` desteği (SharedArrayBuffer dahil)
        // Prisma'nın beklediği `Uint8Array<ArrayBuffer>` ile tip uyuşmazlığı
        // yaratır — `Uint8Array.from` düz bir ArrayBuffer destekli kopya üretir.
        fileData: Uint8Array.from(input.buffer),
        status: "PENDING",
      },
    });
    // Dosya içeriği/adı ASLA audit log'a yazılmaz — yalnızca boyut/tür/kimlik.
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "document_extraction.upload",
      entityType: "DocumentExtraction",
      entityId: record.id,
      after: { mimeType: sniffed, sizeBytes: record.sizeBytes, projectId: record.projectId },
    });
    return record;
  });

  return runExtraction(created.id, input.buffer, sniffed, provider);
}

async function runExtraction(
  documentId: string,
  buffer: Buffer,
  mimeType: SniffedMimeType,
  provider: DocumentExtractionProvider,
) {
  let result: DocumentExtractionResult;
  try {
    result = await provider.extract({ buffer, mimeType });
  } catch {
    // Sağlayıcı hatasının ham mesajı/gövdesi hiçbir yere (DB, log, kullanıcı)
    // YAZILMAZ — yalnızca PII/sır içerebilecek ham hata nesnesi yalnızca
    // yakalanır (bkz. görev talimatı "no OCR payload containing PII should
    // be logged"); DB'de sabit, güvenli bir Türkçe mesaj saklanır.
    return db.documentExtraction.update({
      where: { id: documentId },
      data: { status: "FAILED", providerName: provider.name, errorMessage: "Belge işlenemedi" },
    });
  }

  return db.documentExtraction.update({
    where: { id: documentId },
    data: {
      status: "EXTRACTED",
      providerName: provider.name,
      candidateJson: result as unknown as Prisma.InputJsonValue,
    },
  });
}

async function findDocumentExtractionOrThrow(actor: SessionUser, id: string) {
  const record = await db.documentExtraction.findFirst({
    where: { id, organizationId: actor.organizationId },
  });
  if (!record) throw notFound("Belge bulunamadı");

  if (actor.role === "PROJECT_MANAGER") {
    if (!record.projectId) throw notFound("Belge bulunamadı");
    const isMember = await db.projectMember.findFirst({
      where: { organizationId: actor.organizationId, userId: actor.id, projectId: record.projectId },
    });
    if (!isMember) throw notFound("Belge bulunamadı");
  }

  return record;
}

/** Tenant + rol kapsamlı, taslağı (aday alanlar dahil) döner — hiçbir zaman başka bir organizasyonun kaydını göstermez. */
export async function getDocumentExtractionForUser(actor: SessionUser, id: string) {
  return findDocumentExtractionOrThrow(actor, id);
}

/** DB'den okunan `candidateJson`'ı görüntüleme için tipler — bu servis dışında hiçbir yerde yazılmadığından şekli güvenle bilinir; boşsa/eksikse tüm alanlar null olarak döner (veri uydurulmaz). */
export function parseCandidateResult(json: unknown): DocumentExtractionResult {
  if (!json || typeof json !== "object") return emptyExtractionResult();
  return json as DocumentExtractionResult;
}

/**
 * İnsan onayı — bu fonksiyon dışında hiçbir kod yolu bir OCR taslağından
 * gerçek bir FinancialTransaction üretmez.
 *
 * EXTRACTED (sağlayıcı aday üretti) VEYA FAILED (sağlayıcı başarısız oldu,
 * kullanıcı tüm alanları elle dolduracak) durumlarının HER İKİSİNDEN de onay
 * kabul edilir — OCR'nin başarısız olması, insanın belgeyi elle işleyerek
 * gider kaydı oluşturmasını engellememelidir; yalnızca ön-doldurma ipuçları
 * eksik olur.
 *
 * Mükerrer/yarışan onay koruması: taslak satırı `SELECT ... FOR UPDATE` ile
 * kilitlenip CONFIRMING'e geçiş yapılır ve HEMEN commit edilir.
 * - Zaten CONFIRMED ise: yeni gider oluşturulmadan mevcut sonuç idempotent
 *   olarak döner (istemci tekrar denemesi/ağ zaman aşımı senaryosu).
 * - CONFIRMING (başka bir istek hâlâ işliyor) ise: net bir çakışma hatasıyla
 *   reddedilir — beklemeden ikinci bir gider OLUŞTURULMAZ.
 * - `createExpense` başarısız olursa durum önceki duruma geri alınır (tekrar
 *   denemeye izin verir, taslak sonsuza dek kilitli kalmaz).
 */
export async function confirmDocumentExtraction(actor: SessionUser, input: ConfirmDocumentExtractionInput) {
  // `createExpense` bu kontrolü zaten kendi içinde tekrar yapar (tek kaynak
  // gerçek yetki kontrolü odur) — burada yalnızca yetkisiz bir isteğin satırı
  // gereksiz yere CONFIRMING'e kilitlemesini erkenden önlemek için tekrarlanır.
  if (!canCreateExpense(actor.role)) throw forbidden();

  const claim = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; status: string; confirmedTransactionId: string | null }[]>`
      SELECT id, status, "confirmedTransactionId" FROM "DocumentExtraction"
      WHERE id = ${input.extractionId} AND "organizationId" = ${actor.organizationId}
      FOR UPDATE
    `;
    const locked = rows[0];
    if (!locked) throw notFound("Belge bulunamadı");

    if (actor.role === "PROJECT_MANAGER") {
      const full = await tx.documentExtraction.findUniqueOrThrow({ where: { id: locked.id } });
      if (!full.projectId) throw notFound("Belge bulunamadı");
      const isMember = await tx.projectMember.findFirst({
        where: { organizationId: actor.organizationId, userId: actor.id, projectId: full.projectId },
      });
      if (!isMember) throw notFound("Belge bulunamadı");
    }

    if (locked.status === "CONFIRMED") {
      return { alreadyConfirmed: true as const, transactionId: locked.confirmedTransactionId, previousStatus: null };
    }
    if (locked.status === "CONFIRMING") {
      throw conflict("Bu belge şu anda onaylanıyor, lütfen birazdan tekrar deneyin");
    }
    if (locked.status !== "EXTRACTED" && locked.status !== "FAILED") {
      throw conflict("Belge onaya hazır durumda değil");
    }

    await tx.documentExtraction.update({ where: { id: locked.id }, data: { status: "CONFIRMING" } });
    return { alreadyConfirmed: false as const, transactionId: null, previousStatus: locked.status };
  });

  if (claim.alreadyConfirmed) {
    return { transactionId: claim.transactionId as string, alreadyConfirmed: true };
  }

  let expense;
  try {
    expense = await createExpense(actor, input);
  } catch (err) {
    await db.documentExtraction.updateMany({
      where: { id: input.extractionId, organizationId: actor.organizationId, status: "CONFIRMING" },
      data: { status: claim.previousStatus as "EXTRACTED" | "FAILED" },
    });
    throw err;
  }

  await db.$transaction(async (tx) => {
    await tx.documentExtraction.update({
      where: { id: input.extractionId },
      data: {
        status: "CONFIRMED",
        confirmedTransactionId: expense.id,
        confirmedById: actor.id,
        confirmedAt: new Date(),
      },
    });
    await writeAuditLog(tx, {
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: "document_extraction.confirm",
      entityType: "DocumentExtraction",
      entityId: input.extractionId,
      after: { confirmedTransactionId: expense.id },
    });
  });

  return { transactionId: expense.id, alreadyConfirmed: false };
}
