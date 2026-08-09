import type { AskIntent } from "@/lib/ai/ask/schema";

/**
 * YF-703 — Serbest metin soruyu desteklenen 6 deterministik niyetten birine
 * eşleyen SAF sınıflandırıcı. DB/AI erişimi YOKTUR — çağıran, kullanıcının
 * zaten görebildiği (tenant/rol kapsamlı) proje listesini geçirir; bu
 * fonksiyon o listenin dışına asla çıkmaz (bkz. görev talimatı "prefer a
 * constrained intent model rather than unrestricted agent/tool execution").
 *
 * Eşleşen bir niyet bulunamazsa veya bir proje adı belirsizse, AI ASLA
 * çağrılmaz — açık bir "desteklenmiyor" yanıtı döner (bkz.
 * server/services/ask-yapifin-service.ts "Do not let the model invent
 * unsupported financial facts").
 */

export interface AskProjectCandidate {
  id: string;
  name: string;
  code: string;
}

export type AskClassification =
  | { supported: true; intent: AskIntent; projectId: string | null; projectName: string | null }
  | { supported: false; reason: string };

export const ASK_UNSUPPORTED_REASON =
  "Bu soruyu şu anda yanıtlayamıyorum. Şunlardan birini sorabilirsiniz: bu ayki gelir/gider özeti, bir projenin bütçe/finansal " +
  "durumu, nakit akışı riski, vadesi geçen alacaklar, gider yoğunlaşması veya en fazla bütçe aşımı olan proje.";

export const ASK_AMBIGUOUS_PROJECT_REASON =
  "Sorunuzda birden fazla proje adıyla eşleşme bulundu. Lütfen proje adını veya kodunu daha net belirtin.";

/** Türkçe büyük/küçük harf kurallarına göre normalize eder (İ→i, I→ı) — `.toLowerCase()` bunu doğru yapmaz. */
function normalize(text: string): string {
  return text.toLocaleLowerCase("tr-TR").trim();
}

function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((k) => text.includes(k));
}

const TOP_BUDGET_OVERRUN_KEYWORDS = [
  "en fazla bütçe aşım",
  "en çok bütçe aşan",
  "hangi projede bütçe",
  "en fazla aşan proje",
  "bütçeyi en çok aşan",
  "bütçe aşımı karşılaştırma",
];

const OVERDUE_RECEIVABLES_KEYWORDS = [
  "vadesi geçen alacak",
  "vadesi geçmiş alacak",
  "geciken alacak",
  "tahsil edilmeyen alacak",
];

const CASH_FLOW_KEYWORDS = ["nakit akış", "nakit riski", "kasa riski", "nakit durumu"];

const EXPENSE_CONCENTRATION_KEYWORDS = [
  "gider yoğunlaş",
  "harcama yoğunlaş",
  "hangi kategoride",
  "en çok harcama",
  "en yüksek gider kalemi",
];

const ORG_SUMMARY_KEYWORDS = [
  "toplam gider",
  "toplam gelir",
  "genel finansal durum",
  "şirketin durumu",
  "firmanın durumu",
  "bu ay",
  "bu ayki",
];

const PROJECT_MENTION_KEYWORDS = ["proje", "şantiye"];
const STATUS_QUESTION_KEYWORDS = ["durum", "nasıl", "gidiyor"];

/** Soruda geçen proje adı/kodunu, çağıranın zaten görebildiği proje listesiyle eşleştirir (birden fazla eşleşirse hepsini döner). */
function resolveProjectMatches(text: string, projects: AskProjectCandidate[]): AskProjectCandidate[] {
  return projects.filter((project) => {
    const name = normalize(project.name);
    const code = normalize(project.code);
    if (name.length >= 3 && text.includes(name)) return true;
    if (code.length >= 2 && text.includes(code)) return true;
    return false;
  });
}

export function classifyQuestion(rawQuestion: string, projects: AskProjectCandidate[]): AskClassification {
  const text = normalize(rawQuestion);

  const projectMatches = resolveProjectMatches(text, projects);
  if (projectMatches.length === 1) {
    return { supported: true, intent: "PROJECT_STATUS", projectId: projectMatches[0].id, projectName: projectMatches[0].name };
  }
  if (projectMatches.length > 1) {
    return { supported: false, reason: ASK_AMBIGUOUS_PROJECT_REASON };
  }
  if (matchesAny(text, PROJECT_MENTION_KEYWORDS) && matchesAny(text, STATUS_QUESTION_KEYWORDS)) {
    // Bir projeden bahsediliyor ama hiçbir proje adı/kodu eşleşmedi — hangi
    // projeden söz edildiği belirsiz; uydurmak yerine açıkça bildirilir.
    return { supported: false, reason: ASK_UNSUPPORTED_REASON };
  }

  if (matchesAny(text, TOP_BUDGET_OVERRUN_KEYWORDS)) {
    return { supported: true, intent: "TOP_BUDGET_OVERRUN", projectId: null, projectName: null };
  }
  if (matchesAny(text, OVERDUE_RECEIVABLES_KEYWORDS)) {
    return { supported: true, intent: "OVERDUE_RECEIVABLES", projectId: null, projectName: null };
  }
  if (matchesAny(text, CASH_FLOW_KEYWORDS)) {
    return { supported: true, intent: "CASH_FLOW_STATUS", projectId: null, projectName: null };
  }
  if (matchesAny(text, EXPENSE_CONCENTRATION_KEYWORDS)) {
    return { supported: true, intent: "EXPENSE_CONCENTRATION", projectId: null, projectName: null };
  }
  if (matchesAny(text, ORG_SUMMARY_KEYWORDS)) {
    return { supported: true, intent: "ORG_SUMMARY", projectId: null, projectName: null };
  }

  return { supported: false, reason: ASK_UNSUPPORTED_REASON };
}
