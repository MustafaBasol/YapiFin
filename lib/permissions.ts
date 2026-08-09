import type { UserRole } from "@prisma/client";

/**
 * Rol yetki matrisi — docs/SECURITY.md §1 kaynak alınmıştır. Bu fonksiyonlar
 * yalnızca UI görünürlüğü içindir; her mutation server tarafında da ayrıca
 * kontrol edilir (bkz. server/services).
 */
export const canManageOrganizationSettings = (role: UserRole) => role === "OWNER";
export const canViewOrganizationSettings = (role: UserRole) => role === "OWNER" || role === "ADMIN";
export const canManageUsers = (role: UserRole) => role === "OWNER" || role === "ADMIN";
export const canViewAllProjects = (role: UserRole) =>
  role === "OWNER" || role === "ADMIN" || role === "FINANCE";
export const canCreateProject = (role: UserRole) => role === "OWNER" || role === "ADMIN";
export const canManageProjectTeam = (role: UserRole) => role === "OWNER" || role === "ADMIN";
export const canViewCashAndBank = (role: UserRole) =>
  role === "OWNER" || role === "ADMIN" || role === "FINANCE";
export const canManageAccounts = (role: UserRole) =>
  role === "OWNER" || role === "ADMIN" || role === "FINANCE";
export const canCreateIncome = (role: UserRole) =>
  role === "OWNER" || role === "ADMIN" || role === "FINANCE";
export const canManageIncome = (role: UserRole) =>
  role === "OWNER" || role === "ADMIN" || role === "FINANCE";
/**
 * PROJECT_MANAGER yalnızca atandığı projeye gider girebilir (docs/SECURITY.md §1);
 * proje ataması kontrolü servis katmanında yapılır, bu fonksiyon sadece rolün
 * ilke olarak gider oluşturabildiğini belirtir.
 */
export const canCreateExpense = (role: UserRole) =>
  role === "OWNER" || role === "ADMIN" || role === "FINANCE" || role === "PROJECT_MANAGER";
export const canManageExpenses = (role: UserRole) =>
  role === "OWNER" || role === "ADMIN" || role === "FINANCE";
export const canRecordSettlement = (role: UserRole) =>
  role === "OWNER" || role === "ADMIN" || role === "FINANCE";
export const canRecordTransfer = (role: UserRole) =>
  role === "OWNER" || role === "ADMIN" || role === "FINANCE";
export const canCancelFinancialRecord = (role: UserRole) =>
  role === "OWNER" || role === "ADMIN" || role === "FINANCE";

/**
 * YF-603 — Hakediş oluşturma/düzenleme/onaylama/reddetme/iptal. `canManageIncome`
 * ile aynı ilke: hakediş onayı doğrudan bir gelir tahakkuku (`FinancialTransaction`)
 * yarattığı için gelir yönetimiyle aynı yetki sınırına tabidir. PROJECT_MANAGER
 * kasıtlı olarak DIŞARIDA bırakıldı — atandığı projenin hakedişlerini yalnızca
 * görüntüleyebilir (bkz. server/services/progress-payment-service.ts), tıpkı
 * proje bütçe planlamasında olduğu gibi (`canManageProjectBudget`).
 */
export const canManageProgressPayments = (role: UserRole) =>
  role === "OWNER" || role === "ADMIN" || role === "FINANCE";

/**
 * Müşteri, tedarikçi ve kategori ana kayıtları — docs/SECURITY.md §1 ve
 * PRD kabul kriterlerinde "OWNER/ADMIN yönetir, FINANCE kullanır,
 * PROJECT_MANAGER yalnızca atandığı projelerle sınırlıdır" ilkesine dayanır.
 */
export const canManageCustomers = (role: UserRole) => role === "OWNER" || role === "ADMIN";
export const canManageSuppliers = (role: UserRole) => role === "OWNER" || role === "ADMIN";
export const canManageCategories = (role: UserRole) => role === "OWNER" || role === "ADMIN";

/** Tedarikçi ve kategoriler proje bazlı değil, organizasyon geneli ana kayıtlardır; PROJECT_MANAGER erişemez. */
export const canViewSuppliers = (role: UserRole) =>
  role === "OWNER" || role === "ADMIN" || role === "FINANCE";
export const canViewCategories = (role: UserRole) =>
  role === "OWNER" || role === "ADMIN" || role === "FINANCE";

/**
 * Proje bütçe kalemi planlaması (YF-406) — oluşturma/düzenleme/silme.
 * FINANCE için silme yetkisi, `canManageExpenses`/`canCancelFinancialRecord`
 * ile aynı ilkeyi izler (finans rolü kayıt iptal/silme yapabilir), çünkü
 * bütçe kalemleri kayıtlı finansal işlem değildir ve bu, mevcut en az
 * şaşırtıcı, tutarlı kuraldır. PROJECT_MANAGER için ayrı bir yazma yetkisi
 * kasıtlı olarak TANIMLANMADI: bütçe planlaması, kategori/tedarikçi ana veri
 * yönetimine benzer bir organizasyon-düzeyi finansal planlama işlevidir
 * (`canManageCategories` gibi PM'e kapalı), gider *kaydı* oluşturma
 * yetkisiyle (`canCreateExpense`) karıştırılmamalıdır — o gerçek harcamadır,
 * bu ise plan/tahsis kararıdır. PM salt-okunur kalır (yalnızca atandığı
 * projeler için, bkz. server/services/project-service.ts getProjectForUser).
 */
export const canManageProjectBudget = (role: UserRole) =>
  role === "OWNER" || role === "ADMIN" || role === "FINANCE";

/**
 * YF-605-A — E-belge/muhasebe entegrasyon bağlantı ve kimlik bilgisi yönetimi.
 * Görev talimatında açıkça belirtildiği gibi FINANCE/PROJECT_MANAGER
 * kimlik bilgisi okuyamaz/değiştiremez (bkz. mimari doküman §9); ileride
 * FINANCE'e yalnızca senkronizasyon tetikleme/durum görüntüleme yetkisi
 * eklenmesi ayrı bir karardır, bu fazda TANIMLANMADI.
 */
export const canManageIntegrations = (role: UserRole) => role === "OWNER" || role === "ADMIN";

export function isLastOwnerProtected(targetRole: UserRole, remainingOwners: number) {
  return targetRole === "OWNER" && remainingOwners <= 1;
}

export const ROLE_LABELS: Record<UserRole, string> = {
  OWNER: "Firma Sahibi",
  ADMIN: "Yönetici",
  FINANCE: "Finans",
  PROJECT_MANAGER: "Proje Yöneticisi",
};
