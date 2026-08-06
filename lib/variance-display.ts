/**
 * Bütçe sapma tutarının UI'da nasıl gösterileceğini belirleyen saf
 * (side-effect'siz) yardımcı. Yalnızca işaret (pozitif/negatif/sıfır)
 * karşılaştırması yapar — hiçbir parasal aritmetik içermez, bu yüzden
 * Number() ile karşılaştırma güvenlidir (zaten sunucuda Decimal ile
 * hesaplanmış bir string'in işaretine bakılır).
 */
export type VarianceTone = "destructive" | "success" | "neutral";

export interface VarianceCardSemantics {
  tone: VarianceTone;
  hint: string;
}

export function getVarianceTone(amount: string): VarianceTone {
  const n = Number(amount);
  if (n > 0) return "destructive";
  if (n < 0) return "success";
  return "neutral";
}

/** "Bütçe Sapması" kartı için: pozitif = aşım, negatif = tasarruf, sıfır = tam isabet. */
export function getVarianceCardSemantics(amount: string): VarianceCardSemantics {
  const tone = getVarianceTone(amount);
  if (tone === "destructive") return { tone, hint: "Planlananın üzerinde" };
  if (tone === "success") return { tone, hint: "Planlananın altında" };
  return { tone, hint: "Planlananla aynı" };
}
