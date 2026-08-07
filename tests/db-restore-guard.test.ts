import { describe, expect, it } from "vitest";
import { ArgParseError, evaluateTarget, parseArgs } from "../scripts/db-restore-guard.mjs";

describe("db-restore-guard parseArgs", () => {
  it("geçerli host/db/port kabul eder", () => {
    expect(parseArgs(["--host", "localhost", "--db", "yapifin_restore_drill", "--port", "55432"])).toEqual({
      host: "localhost",
      db: "yapifin_restore_drill",
      port: "55432",
    });
  });

  it("--port verilmezse 5432 varsayılanını kullanır", () => {
    expect(parseArgs(["--host", "localhost", "--db", "yapifin_restore_drill"]).port).toBe("5432");
  });

  it("--host değeri başka bir bayrağa kayarsa reddeder (--host --db X)", () => {
    expect(() => parseArgs(["--host", "--db", "yapifin_restore_drill"])).toThrow(ArgParseError);
  });

  it("--db değeri başka bir bayrağa kayarsa reddeder (--db --host localhost)", () => {
    expect(() => parseArgs(["--db", "--host", "localhost"])).toThrow(ArgParseError);
  });

  it("--port değersiz verilirse reddeder (sessizce 5432'ye düşmez)", () => {
    expect(() => parseArgs(["--host", "localhost", "--db", "yapifin_restore_drill", "--port"])).toThrow(
      ArgParseError
    );
  });

  it("--port değeri sayısal değilse reddeder", () => {
    expect(() =>
      parseArgs(["--host", "localhost", "--db", "yapifin_restore_drill", "--port", "abc"])
    ).toThrow(ArgParseError);
  });

  it("--port aralık dışıysa reddeder (0 ve 65536)", () => {
    expect(() =>
      parseArgs(["--host", "localhost", "--db", "yapifin_restore_drill", "--port", "0"])
    ).toThrow(ArgParseError);
    expect(() =>
      parseArgs(["--host", "localhost", "--db", "yapifin_restore_drill", "--port", "65536"])
    ).toThrow(ArgParseError);
  });

  it("host veya db eksikse reddeder", () => {
    expect(() => parseArgs(["--port", "5432"])).toThrow(ArgParseError);
    expect(() => parseArgs(["--host", "localhost"])).toThrow(ArgParseError);
    expect(() => parseArgs(["--db", "yapifin_restore_drill"])).toThrow(ArgParseError);
  });

  it("tekrarlanan/çakışan bayrağı reddeder", () => {
    expect(() =>
      parseArgs(["--host", "a", "--host", "b", "--db", "yapifin_restore_drill"])
    ).toThrow(ArgParseError);
  });

  it("tanınmayan bayrağı reddeder", () => {
    expect(() =>
      parseArgs(["--host", "localhost", "--db", "yapifin_restore_drill", "--foo", "bar"])
    ).toThrow(ArgParseError);
  });

  it("hata mesajı yalnızca ilgili bayrağı/değeri içerir, ortam değişkenlerindeki sırları sızdırmaz", () => {
    const originalPgPassword = process.env.PGPASSWORD;
    process.env.PGPASSWORD = "s3cr3t-should-not-appear";
    let message = "";
    try {
      parseArgs(["--host", "localhost", "--db", "yapifin_restore_drill", "--port", "abc"]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    } finally {
      if (originalPgPassword === undefined) delete process.env.PGPASSWORD;
      else process.env.PGPASSWORD = originalPgPassword;
    }
    expect(message).toContain('"abc"');
    expect(message).not.toContain("s3cr3t-should-not-appear");
  });
});

describe("db-restore-guard evaluateTarget", () => {
  it("PROD_DB_HOST/PROD_DB_NAME birebir eşleşmesini koşulsuz reddeder", () => {
    const result = evaluateTarget(
      { host: "prod-db.internal", db: "yapifin_restore_drill" },
      { PROD_DB_HOST: "prod-db.internal", PROD_DB_NAME: "yapifin_restore_drill" }
    );
    expect(result.ok).toBe(false);
  });

  it("disposable isim deseni yoksa reddeder", () => {
    expect(evaluateTarget({ host: "localhost", db: "yapifin" }, {}).ok).toBe(false);
  });

  it("host veya db adında 'prod' geçiyorsa reddeder", () => {
    expect(evaluateTarget({ host: "prod-host", db: "yapifin_restore_drill" }, {}).ok).toBe(false);
    expect(evaluateTarget({ host: "localhost", db: "prod_restore_drill" }, {}).ok).toBe(false);
  });

  it("disposable ad + prod olmayan host/db kabul eder", () => {
    expect(evaluateTarget({ host: "localhost", db: "yapifin_restore_drill" }, {}).ok).toBe(true);
  });
});
