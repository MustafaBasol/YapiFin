import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { addIstanbulDays, fromIstanbulComponents } from "@/lib/dates";
import {
  CASH_SCENARIO_DELAY_DAYS,
  CASH_SCENARIO_HORIZON_DAYS,
  CASH_SCENARIOS,
  buildCashScenarioSeries,
  cashScenarioDayIndex,
  computeCashScenarioCells,
  summarizeCashScenarioPrefix,
  type CashScenario,
  type CashScenarioCell,
  type CashScenarioHorizon,
  type CashScenarioRow,
} from "@/server/services/cash-flow-scenario-math";

/**
 * YF-705 — Senaryo matematiğinin ALTIN fikstürleri.
 *
 * Bu dosya veritabanına HİÇ dokunmaz: saf çekirdek, elle hesaplanmış
 * referans değerlerle doğrulanır. Servis/kapsam/AI testleri ayrı dosyadadır.
 */

// 2026-08-13 00:00 Istanbul
const TODAY_START = fromIstanbulComponents(2026, 7, 13);

function d(year: number, monthIndex: number, day: number): Date {
  return fromIstanbulComponents(year, monthIndex, day);
}

function dec(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function row(
  id: string,
  type: "INCOME" | "EXPENSE",
  dueDate: Date,
  remaining: string,
  currency = "TRY",
): CashScenarioRow {
  return { id, type, dueDate, remaining: dec(remaining), currency };
}

/** Fikstür A — açılış nakdi 100.000. */
const FIXTURE_ROWS: CashScenarioRow[] = [
  row("R1", "INCOME", d(2026, 6, 30), "40000"), // gün -14, vadesi geçmiş
  row("R2", "INCOME", d(2026, 7, 25), "60000"), // gün 12
  row("R3", "INCOME", d(2026, 8, 20), "80000"), // gün 38 (100.000 - 20.000 aktif settlement)
  row("R4", "INCOME", d(2026, 10, 5), "50000"), // gün 84
  row("P1", "EXPENSE", d(2026, 7, 10), "30000"), // gün -3, vadesi geçmiş
  row("P2", "EXPENSE", d(2026, 8, 5), "90000"), // gün 23
  row("P3", "EXPENSE", d(2026, 9, 20), "70000"), // gün 68
];

function cellsFor(openingCash: Prisma.Decimal | null, rows = FIXTURE_ROWS): CashScenarioCell[] {
  return computeCashScenarioCells({ rows, todayStart: TODAY_START, openingCash, assumptions: [] });
}

function cell(cells: CashScenarioCell[], scenario: CashScenario, horizonDays: CashScenarioHorizon) {
  const found = cells.find((c) => c.scenario === scenario && c.horizonDays === horizonDays);
  if (!found) throw new Error(`hücre yok: ${scenario}/${horizonDays}`);
  return found;
}

describe("YF-705 — ufuk ve gün indeksi semantiği", () => {
  it("ufuklar YARI AÇIKtır: [bugün, bugün+N) ve N. gün HARİÇtir", () => {
    const cells = cellsFor(dec("100000"));
    for (const horizonDays of CASH_SCENARIO_HORIZON_DAYS) {
      const c = cell(cells, "BASE", horizonDays);
      expect(c.windowStart.getTime()).toBe(TODAY_START.getTime());
      expect(c.windowEnd.getTime()).toBe(addIstanbulDays(TODAY_START, horizonDays).getTime());
      const spanDays = (c.windowEnd.getTime() - c.windowStart.getTime()) / 86_400_000;
      expect(spanDays).toBe(horizonDays);
    }
  });

  it("gün indeksi Math.floor kullanır — öğleden sonra saati bir sonraki güne TAŞIMAZ", () => {
    const afternoon = new Date(addIstanbulDays(TODAY_START, 5).getTime() + 18 * 60 * 60 * 1000);
    expect(cashScenarioDayIndex(afternoon, TODAY_START)).toBe(5);
    const justBeforeMidnight = new Date(addIstanbulDays(TODAY_START, 5).getTime() + 86_400_000 - 1);
    expect(cashScenarioDayIndex(justBeforeMidnight, TODAY_START)).toBe(5);
  });

  it("tam ufuk sınırındaki kayıt DIŞARIDA kalır (off-by-one koruması)", () => {
    const boundary = [row("B1", "INCOME", addIstanbulDays(TODAY_START, 30), "10000")];
    const cells = cellsFor(dec("0"), boundary);
    expect(cell(cells, "BASE", 30).expectedCollections).toBe("0");
    expect(cell(cells, "BASE", 60).expectedCollections).toBe("10000");
  });
});

describe("YF-705 — Fikstür A: dokuz hücrenin altın değerleri (açılış 100.000)", () => {
  const cells = cellsFor(dec("100000"));

  const expected: Array<[CashScenario, CashScenarioHorizon, string, string, string]> = [
    // scenario, horizon, collections, payments, endingCash
    ["BASE", 30, "100000", "120000", "80000"],
    ["BASE", 60, "180000", "120000", "160000"],
    ["BASE", 90, "230000", "190000", "140000"],
    ["RISK", 30, "40000", "120000", "20000"],
    ["RISK", 60, "100000", "120000", "80000"],
    ["RISK", 90, "180000", "190000", "90000"],
    ["OPTIMISTIC", 30, "100000", "30000", "170000"],
    ["OPTIMISTIC", 60, "180000", "120000", "160000"],
    ["OPTIMISTIC", 90, "230000", "190000", "140000"],
  ];

  for (const [scenario, horizonDays, collections, payments, endingCash] of expected) {
    it(`${scenario}/${horizonDays}: tahsilat ${collections}, ödeme ${payments}, kapanış ${endingCash}`, () => {
      const c = cell(cells, scenario, horizonDays);
      expect(c.expectedCollections).toBe(collections);
      expect(c.expectedPayments).toBe(payments);
      expect(c.endingCash).toBe(endingCash);
      expect(c.netChange).toBe(dec(collections).minus(dec(payments)).toString());
    });
  }

  it("açılış nakdi dokuz hücrede de AYNIdır — senaryo onu değiştirmez", () => {
    for (const c of cells) expect(c.openingCash).toBe("100000");
  });

  it("Fikstür A'da hiçbir senaryoda kırılma yoktur", () => {
    for (const c of cells) {
      expect(c.breakDate).toBeNull();
      expect(c.willBreak).toBe(false);
      expect(c.alreadyNegativeAtOpening).toBe(false);
    }
  });

  it("minimum nakit BASE/30'da 23. gün (05.09.2026) 80.000'dir", () => {
    const c = cell(cells, "BASE", 30);
    expect(c.minimumCashPoint?.amount).toBe("80000");
    expect(c.minimumCashPoint?.dayIndex).toBe(23);
    expect(c.minimumCashPoint?.date.getTime()).toBe(d(2026, 8, 5).getTime());
    expect(c.minimumCashPoint?.isOpeningPoint).toBe(false);
  });

  it("İYİMSER/30'da minimum nokta AÇILIŞ anıdır (tüm akışlar pozitif)", () => {
    const c = cell(cells, "OPTIMISTIC", 30);
    expect(c.minimumCashPoint?.isOpeningPoint).toBe(true);
    expect(c.minimumCashPoint?.dayIndex).toBe(-1);
    expect(c.minimumCashPoint?.amount).toBe("100000");
    expect(c.minimumCashPoint?.date.getTime()).toBe(TODAY_START.getTime());
  });
});

describe("YF-705 — iyimser senaryo GELİR UYDURMAZ", () => {
  const cells = cellsFor(dec("100000"));

  it("İYİMSER tahsilatları BAZ ile BİREBİR aynıdır (her ufukta)", () => {
    for (const horizonDays of CASH_SCENARIO_HORIZON_DAYS) {
      expect(cell(cells, "OPTIMISTIC", horizonDays).expectedCollections).toBe(
        cell(cells, "BASE", horizonDays).expectedCollections,
      );
    }
  });

  it("RİSK ödemeleri BAZ ile BİREBİR aynıdır (risk giderleri hızlandırmaz)", () => {
    for (const horizonDays of CASH_SCENARIO_HORIZON_DAYS) {
      expect(cell(cells, "RISK", horizonDays).expectedPayments).toBe(
        cell(cells, "BASE", horizonDays).expectedPayments,
      );
    }
  });

  it("İYİMSER gecikmesi ödemeleri yalnızca AZALTIR, asla artırmaz", () => {
    for (const horizonDays of CASH_SCENARIO_HORIZON_DAYS) {
      const optimistic = dec(cell(cells, "OPTIMISTIC", horizonDays).expectedPayments);
      const base = dec(cell(cells, "BASE", horizonDays).expectedPayments);
      expect(optimistic.lessThanOrEqualTo(base)).toBe(true);
    }
  });

  it("hiçbir senaryo toplamı, kayıtlı kalan tutarların toplamını AŞAMAZ", () => {
    const totalIncome = FIXTURE_ROWS.filter((r) => r.type === "INCOME").reduce(
      (acc, r) => acc.plus(r.remaining),
      new Prisma.Decimal(0),
    );
    for (const c of cells) {
      expect(dec(c.expectedCollections).lessThanOrEqualTo(totalIncome)).toBe(true);
    }
  });
});

describe("YF-705 — senaryo sıralaması değişmezleri", () => {
  const cells = cellsFor(dec("100000"));

  it("RİSK ≤ BAZ ≤ İYİMSER (kapanış nakdi)", () => {
    for (const horizonDays of CASH_SCENARIO_HORIZON_DAYS) {
      const risk = dec(cell(cells, "RISK", horizonDays).endingCash!);
      const base = dec(cell(cells, "BASE", horizonDays).endingCash!);
      const optimistic = dec(cell(cells, "OPTIMISTIC", horizonDays).endingCash!);
      expect(risk.lessThanOrEqualTo(base)).toBe(true);
      expect(base.lessThanOrEqualTo(optimistic)).toBe(true);
    }
  });

  it("RİSK ≤ BAZ ≤ İYİMSER (minimum nakit)", () => {
    for (const horizonDays of CASH_SCENARIO_HORIZON_DAYS) {
      const risk = dec(cell(cells, "RISK", horizonDays).minimumCashPoint!.amount);
      const base = dec(cell(cells, "BASE", horizonDays).minimumCashPoint!.amount);
      const optimistic = dec(cell(cells, "OPTIMISTIC", horizonDays).minimumCashPoint!.amount);
      expect(risk.lessThanOrEqualTo(base)).toBe(true);
      expect(base.lessThanOrEqualTo(optimistic)).toBe(true);
    }
  });
});

describe("YF-705 — vadesi geçmiş kalemler", () => {
  it("vadesi geçmiş kayıtlar pencerenin ilk gününe KIRPILIR (BAZ)", () => {
    const series = buildCashScenarioSeries({
      rows: FIXTURE_ROWS,
      collectionDelayDays: 0,
      paymentDelayDays: 0,
      todayStart: TODAY_START,
    });
    expect(series.inflow[0].toString()).toBe("40000");
    expect(series.outflow[0].toString()).toBe("30000");
  });

  it("KAYDIR-SONRA-KIRP: 3 gün gecikmiş borç İYİMSER'de 12. güne gider, 15. güne DEĞİL", () => {
    const series = buildCashScenarioSeries({
      rows: [row("P1", "EXPENSE", d(2026, 7, 10), "30000")],
      collectionDelayDays: 0,
      paymentDelayDays: 15,
      todayStart: TODAY_START,
    });
    expect(series.outflow[12].toString()).toBe("30000");
    expect(series.outflow[15].toString()).toBe("0");
    expect(series.outflow[0].toString()).toBe("0");
  });

  it("RİSK vadesi geçmiş tahsilatı gerçekten GELECEĞE öteler (14 gün gecikmiş → 16. gün)", () => {
    const series = buildCashScenarioSeries({
      rows: [row("R1", "INCOME", d(2026, 6, 30), "40000")],
      collectionDelayDays: 30,
      paymentDelayDays: 0,
      todayStart: TODAY_START,
    });
    expect(series.inflow[16].toString()).toBe("40000");
    expect(series.inflow[0].toString()).toBe("0");
  });

  it("vadesi geçmiş maruziyet RAPORLANIR ama toplama EKLENMEZ", () => {
    const cells = cellsFor(dec("100000"));
    for (const c of cells) {
      expect(c.overdueReceivableIncluded).toBe("40000");
      expect(c.overduePayableIncluded).toBe("30000");
      // Alt küme olmalı — asla toplamı aşmamalı.
      expect(dec(c.overdueReceivableIncluded).lessThanOrEqualTo(dec(c.expectedCollections))).toBe(true);
      expect(dec(c.overduePayableIncluded).lessThanOrEqualTo(dec(c.expectedPayments))).toBe(true);
    }
  });

  it("vadesi geçmiş kalem TAM OLARAK BİR KEZ sayılır", () => {
    const single = [row("R1", "INCOME", d(2026, 6, 30), "40000")];
    const cells = cellsFor(dec("0"), single);
    expect(cell(cells, "BASE", 30).expectedCollections).toBe("40000");
    expect(cell(cells, "BASE", 90).expectedCollections).toBe("40000");
  });
});

describe("YF-705 — Fikstür B: kırılma tarihi (açılış 10.000)", () => {
  const cells = cellsFor(dec("10000"));

  it("BAZ 23. günde kırılır (05.09.2026)", () => {
    for (const horizonDays of CASH_SCENARIO_HORIZON_DAYS) {
      const c = cell(cells, "BASE", horizonDays);
      expect(c.breakDayIndex).toBe(23);
      expect(c.breakDate?.getTime()).toBe(d(2026, 8, 5).getTime());
      expect(c.willBreak).toBe(true);
    }
  });

  it("RİSK ilk günde kırılır — vadesi geçmiş borç bugüne kırpılır", () => {
    const c = cell(cells, "RISK", 30);
    expect(c.breakDayIndex).toBe(0);
    expect(c.breakDate?.getTime()).toBe(TODAY_START.getTime());
  });

  it("İYİMSER hiç kırılmaz", () => {
    for (const horizonDays of CASH_SCENARIO_HORIZON_DAYS) {
      const c = cell(cells, "OPTIMISTIC", horizonDays);
      expect(c.breakDate).toBeNull();
      expect(c.willBreak).toBe(false);
    }
  });

  it("bakiye TAM SIFIR olduğunda kırılma SAYILMAZ (kesin < 0)", () => {
    // BAZ/90'da 68. gün kümülatifi tam 0'dır; en erken kırılma 23'te kalır.
    const c = cell(cells, "BASE", 90);
    expect(c.breakDayIndex).toBe(23);
    // RİSK/90 kapanışı tam 0 — kapanış kırılma yaratmaz.
    const risk = cell(cells, "RISK", 90);
    expect(risk.endingCash).toBe("0");
  });

  it("İYİMSER/90'da minimum 0'dır ama kırılma YOKTUR (minimum ve kırılma bağımsızdır)", () => {
    const c = cell(cells, "OPTIMISTIC", 90);
    expect(c.minimumCashPoint?.amount).toBe("0");
    expect(c.breakDate).toBeNull();
  });

  it("ÖN EK değişmezi: 30 günde bulunan kırılma 60 ve 90'da AYNI kalır", () => {
    for (const scenario of CASH_SCENARIOS) {
      const at30 = cell(cells, scenario, 30).breakDayIndex;
      if (at30 === null) continue;
      expect(cell(cells, scenario, 60).breakDayIndex).toBe(at30);
      expect(cell(cells, scenario, 90).breakDayIndex).toBe(at30);
    }
  });
});

describe("YF-705 — Fikstür C: negatif açılış ve boş kayıt kümesi", () => {
  const cells = cellsFor(dec("-5000"), []);

  it("açılışta zaten negatifse kırılma tarihi BUGÜNdür ve -1 işaretçisi taşınır", () => {
    for (const c of cells) {
      expect(c.alreadyNegativeAtOpening).toBe(true);
      expect(c.breakDayIndex).toBe(-1);
      expect(c.breakDate?.getTime()).toBe(TODAY_START.getTime());
      expect(c.willBreak).toBe(true);
    }
  });

  it("kayıt yoksa tahmin düz kalır: kapanış = açılış", () => {
    for (const c of cells) {
      expect(c.expectedCollections).toBe("0");
      expect(c.expectedPayments).toBe("0");
      expect(c.endingCash).toBe("-5000");
      expect(c.minimumCashPoint?.isOpeningPoint).toBe(true);
    }
  });
});

describe("YF-705 — kümülatif seri ile toplu yüklem UYUŞUR (köprü testi)", () => {
  it("her senaryo/ufuk için gün gün toplam === toplu tahsilat/ödeme", () => {
    for (const scenario of CASH_SCENARIOS) {
      const { collectionDelayDays, paymentDelayDays } = CASH_SCENARIO_DELAY_DAYS[scenario];
      const series = buildCashScenarioSeries({
        rows: FIXTURE_ROWS,
        collectionDelayDays,
        paymentDelayDays,
        todayStart: TODAY_START,
      });
      for (const horizonDays of CASH_SCENARIO_HORIZON_DAYS) {
        const summary = summarizeCashScenarioPrefix({
          series,
          rows: FIXTURE_ROWS,
          scenario,
          horizonDays,
          todayStart: TODAY_START,
          openingCash: new Prisma.Decimal(100000),
          assumptions: [],
        });

        // Bağımsız yeniden hesap: kaydırılmış vade < pencere sonu yüklemi.
        const windowEnd = addIstanbulDays(TODAY_START, horizonDays);
        let collections = new Prisma.Decimal(0);
        let payments = new Prisma.Decimal(0);
        for (const r of FIXTURE_ROWS) {
          const delay = r.type === "INCOME" ? collectionDelayDays : paymentDelayDays;
          const shifted = addIstanbulDays(r.dueDate, delay);
          if (shifted.getTime() >= windowEnd.getTime()) continue;
          if (r.type === "INCOME") collections = collections.plus(r.remaining);
          else payments = payments.plus(r.remaining);
        }

        expect(summary.expectedCollections).toBe(collections.toString());
        expect(summary.expectedPayments).toBe(payments.toString());
      }
    }
  });

  it("kümülatif serinin son günü === kapanış nakdi", () => {
    for (const scenario of CASH_SCENARIOS) {
      const { collectionDelayDays, paymentDelayDays } = CASH_SCENARIO_DELAY_DAYS[scenario];
      const series = buildCashScenarioSeries({
        rows: FIXTURE_ROWS,
        collectionDelayDays,
        paymentDelayDays,
        todayStart: TODAY_START,
      });
      for (const horizonDays of CASH_SCENARIO_HORIZON_DAYS) {
        let running = new Prisma.Decimal(100000);
        for (let i = 0; i < horizonDays; i += 1) {
          running = running.plus(series.inflow[i]).minus(series.outflow[i]);
        }
        const summary = summarizeCashScenarioPrefix({
          series,
          rows: FIXTURE_ROWS,
          scenario,
          horizonDays,
          todayStart: TODAY_START,
          openingCash: new Prisma.Decimal(100000),
          assumptions: [],
        });
        expect(summary.endingCash).toBe(running.toString());
      }
    }
  });
});

describe("YF-705 — Decimal kesinliği ve nakit görünürlüğü", () => {
  it("kuruşlu tutarlar kayan noktaya DÜŞMEDEN korunur", () => {
    const cents = [
      row("A", "INCOME", d(2026, 7, 20), "0.1"),
      row("B", "INCOME", d(2026, 7, 21), "0.2"),
    ];
    const cells = computeCashScenarioCells({
      rows: cents,
      todayStart: TODAY_START,
      openingCash: new Prisma.Decimal("0"),
      assumptions: [],
    });
    // 0.1 + 0.2 kayan noktada 0.30000000000000004 olurdu.
    expect(cell(cells, "BASE", 30).expectedCollections).toBe("0.3");
  });

  it("büyük tutarlarda hassasiyet kaybı olmaz", () => {
    const big = [row("A", "INCOME", d(2026, 7, 20), "123456789012.34")];
    const cells = computeCashScenarioCells({
      rows: big,
      todayStart: TODAY_START,
      openingCash: new Prisma.Decimal("0.01"),
      assumptions: [],
    });
    expect(cell(cells, "BASE", 30).endingCash).toBe("123456789012.35");
  });

  it("nakit görünürlüğü yoksa akışlar üretilir ama nakit alanları NULL kalır", () => {
    const cells = cellsFor(null);
    for (const c of cells) {
      expect(c.openingCash).toBeNull();
      expect(c.endingCash).toBeNull();
      expect(c.minimumCashPoint).toBeNull();
      expect(c.breakDate).toBeNull();
      expect(c.willBreak).toBe(false);
      // Akışlar yine hesaplanır.
      expect(c.expectedCollections).not.toBe("");
    }
    expect(cell(cells, "BASE", 30).expectedCollections).toBe("100000");
  });
});

describe("YF-705 — varsayımlar görünürdür", () => {
  it("her hücre kendi senaryo varsayımını taşır", () => {
    const cells = cellsFor(dec("100000"));
    expect(cell(cells, "BASE", 30).assumptions).toContain("SCENARIO_ON_DUE_DATE");
    expect(cell(cells, "RISK", 30).assumptions).toContain("SCENARIO_COLLECTIONS_DELAYED_30D");
    expect(cell(cells, "OPTIMISTIC", 30).assumptions).toContain("SCENARIO_PAYMENTS_DEFERRED_15D");
  });

  it("vadesi geçmiş kalem varsa OVERDUE_AT_WINDOW_START varsayımı eklenir", () => {
    const cells = cellsFor(dec("100000"));
    for (const c of cells) expect(c.assumptions).toContain("OVERDUE_AT_WINDOW_START");
  });

  it("vadesi geçmiş kalem yoksa o varsayım eklenmez", () => {
    const future = [row("R", "INCOME", d(2026, 7, 25), "1000")];
    const cells = cellsFor(dec("0"), future);
    for (const c of cells) expect(c.assumptions).not.toContain("OVERDUE_AT_WINDOW_START");
  });

  it("negatif gecikme reddedilir", () => {
    expect(() =>
      buildCashScenarioSeries({
        rows: FIXTURE_ROWS,
        collectionDelayDays: -1,
        paymentDelayDays: 0,
        todayStart: TODAY_START,
      }),
    ).toThrow(/Negatif senaryo/);
  });
});
