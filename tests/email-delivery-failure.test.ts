import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg } from "./helpers";

const { sendVerificationEmailMock, sendPasswordResetEmailMock, sendInvitationEmailMock } = vi.hoisted(() => ({
  sendVerificationEmailMock: vi.fn(async () => {}),
  sendPasswordResetEmailMock: vi.fn(async () => {}),
  sendInvitationEmailMock: vi.fn(async () => {}),
}));

vi.mock("@/lib/email/mailer", () => ({
  sendVerificationEmail: sendVerificationEmailMock,
  sendPasswordResetEmail: sendPasswordResetEmailMock,
  sendInvitationEmail: sendInvitationEmailMock,
}));

import { registerOwnerAndOrganization } from "@/server/services/organization-service";
import { requestPasswordReset, resendVerificationEmail } from "@/server/services/auth-service";
import { createInvitation, resendInvitation } from "@/server/services/invitation-service";

beforeAll(async () => {
  await cleanDatabase();
});
afterEach(async () => {
  // mockClear() (mockReset() değil) kullanılır: reset, vi.fn(impl) ile
  // verilen varsayılan (başarılı) uygulamayı da siler ve mock'u undefined
  // döner hale getirir — sonraki testlerdeki gerçek servis çağrılarını
  // (ör. createOwnerOrg) bozar.
  sendVerificationEmailMock.mockClear();
  sendPasswordResetEmailMock.mockClear();
  sendInvitationEmailMock.mockClear();
  await cleanDatabase();
});
afterAll(async () => {
  await db.$disconnect();
});

describe("e-posta gönderim hatalarında dürüst davranış", () => {
  it("kayıt: doğrulama e-postası başarısız olsa da organizasyon/kullanıcı geri alınmaz, verificationEmailSent=false döner", async () => {
    sendVerificationEmailMock.mockRejectedValueOnce(new Error("smtp down"));

    const result = await registerOwnerAndOrganization({
      firstName: "Ayşe",
      lastName: "Yılmaz",
      email: "fail-verify@example.com",
      phone: "",
      password: "Sifre1234",
      organizationName: "Test İnşaat Email Fail",
      city: "",
      district: "",
      taxOffice: "",
      taxNumber: "",
    });

    expect(result.verificationEmailSent).toBe(false);
    const user = await db.user.findUnique({ where: { id: result.userId } });
    const org = await db.organization.findUnique({ where: { id: result.organizationId } });
    expect(user).not.toBeNull();
    expect(org).not.toBeNull();
  });

  it("parola sıfırlama: e-posta hatası fırlatmaz — var olan ve olmayan e-posta için aynı sonuç (numaralandırma koruması)", async () => {
    const { owner } = await createOwnerOrg();
    sendPasswordResetEmailMock.mockRejectedValueOnce(new Error("smtp down"));

    await expect(requestPasswordReset(owner.email)).resolves.toBeUndefined();
    await expect(requestPasswordReset("hic-kayitli-olmayan@example.com")).resolves.toBeUndefined();
  });

  it("doğrulama e-postası yeniden gönderim hatası yutulmaz, çağırana yansır", async () => {
    const { owner } = await createOwnerOrg();
    sendVerificationEmailMock.mockRejectedValueOnce(new Error("smtp down"));

    await expect(resendVerificationEmail(owner.id)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("davet: e-posta hatası fırlatılır ve davet kaydı yeniden gönderilebilecek şekilde DB'de kalır", async () => {
    const { owner } = await createOwnerOrg();
    sendInvitationEmailMock.mockRejectedValueOnce(new Error("smtp down"));

    await expect(
      createInvitation(owner, { email: "davetli@example.com", role: "FINANCE", projectIds: [] }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const invitation = await db.invitation.findFirst({
      where: { organizationId: owner.organizationId, email: "davetli@example.com" },
    });
    expect(invitation).not.toBeNull();
  });

  it("davet yeniden gönderimi: e-posta hatası fırlatılır, yanıltıcı 'gönderildi' durumu oluşmaz", async () => {
    const { owner } = await createOwnerOrg();
    const invitation = await createInvitation(owner, {
      email: "davetli2@example.com",
      role: "FINANCE",
      projectIds: [],
    });
    sendInvitationEmailMock.mockRejectedValueOnce(new Error("smtp down"));

    await expect(resendInvitation(owner, invitation.id)).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
