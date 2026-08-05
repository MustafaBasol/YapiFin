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

export function isLastOwnerProtected(targetRole: UserRole, remainingOwners: number) {
  return targetRole === "OWNER" && remainingOwners <= 1;
}

export const ROLE_LABELS: Record<UserRole, string> = {
  OWNER: "Firma Sahibi",
  ADMIN: "Yönetici",
  FINANCE: "Finans",
  PROJECT_MANAGER: "Proje Yöneticisi",
};
