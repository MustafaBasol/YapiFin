// YF-514 — Kimlik bilgisi içeren bağlantı dizelerinin logda/CI çıktısında
// görünmesini önlemek için tek yetkili redaksiyon noktası.

/** `user:pass@` bölümünü `***@` ile değiştirir; kimlik bilgisi yoksa dizeyi olduğu gibi döndürür. */
export function redactConnectionString(connectionString) {
  if (typeof connectionString !== "string" || connectionString.length === 0) return "***";
  return connectionString.replace(/\/\/[^@/]*@/, "//***@");
}
