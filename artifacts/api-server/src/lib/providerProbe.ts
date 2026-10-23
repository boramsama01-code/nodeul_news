import axios from "axios";
import { classifyProviderResponse, providerResponseEvidence, recordProviderHealth } from "./providerHealth";

export type ProbeProvider = "naver_web" | "daum_web";

function todayKst(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

export async function probeSearchProvider(provider: ProbeProvider): Promise<{ ok: boolean; reason: string; checkedAt: string }> {
  const checkedAt = new Date().toISOString();
  const day = todayKst();
  const dotted = day.replace(/-/g, ".");
  const common = {
    timeout: 20_000,
    responseType: "text" as const,
    maxRedirects: 0,
    validateStatus: () => true,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  };

  const response = provider === "naver_web"
    ? await axios.get<string>("https://search.naver.com/search.naver", {
        ...common,
        params: { where: "news", query: "노들섬", sort: "1", pd: "3", ds: dotted, de: dotted },
      })
    : await axios.get<string>("https://search.daum.net/search", {
        ...common,
        params: { w: "news", q: "노들섬", sort: "recency", period: "u", sd: day.replace(/-/g, "") + "000000", ed: day.replace(/-/g, "") + "235959", p: 1 },
      });

  const body = String(response.data || "");
  const location = String(response.headers?.location || "");
  const classification = /captcha|challenge/i.test(location)
    ? { kind: "challenge" as const, reason: "사람 확인(CAPTCHA) 페이지로 이동 응답" }
    : classifyProviderResponse(response.status, body);
  const limited = response.status !== 200 || ["challenge", "automated", "rate", "forbidden"].includes(classification.kind);

  if (limited) {
    const reason = classification.reason;
    await recordProviderHealth(provider, {
      status: "limited",
      reason,
      checkedAt,
      httpStatus: response.status,
      responseEvidence: providerResponseEvidence(body),
      blockedUntil: new Date(Date.now() + 6 * 3600_000).toISOString(),
    });
    return { ok: false, reason, checkedAt };
  }

  const reason = "단일 검색어·1일·첫 페이지 최소 요청에서 정상 응답 확인";
  await recordProviderHealth(provider, { status: "ok", reason, checkedAt, httpStatus: 200 });
  return { ok: true, reason, checkedAt };
}
