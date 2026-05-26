// Relevance filter — "노들" 포함 기사 수집, 단 "노들장애인야학"·"노들강변" 제외
const EXCLUDE_PATTERNS = ["노들장애인야학", "노들강변"];

export function isRelevant(title: string, content: string): boolean {
  const text = title + " " + content;
  if (!text.includes("노들")) return false;
  return !EXCLUDE_PATTERNS.some((e) => text.includes(e));
}

// Rule-based negative sentiment analysis (used when ANTHROPIC_API_KEY is not set)
const NEGATIVE_KEYWORDS = [
  "논란", "반대", "비판", "비난", "갈등", "충돌", "실패", "취소", "무산",
  "반발", "항의", "규탄", "성토", "철거", "폐쇄", "민원", "소음", "피해",
  "불법", "위반", "사고", "사망", "부상", "침수", "화재", "노키즈", "차별",
  "엉터리", "엉망", "형편없", "최악", "부실", "의혹", "탈세", "비리", "부패",
  "강제", "퇴출", "폐지", "예산낭비", "세금낭비", "특혜", "특권", "꼼수",
  "억울", "횡포", "갑질", "호소", "청원", "시위", "집회", "데모",
];

export function ruleBasedSentiment(title: string, content: string): boolean {
  const text = (title + " " + content);
  return NEGATIVE_KEYWORDS.some((kw) => text.includes(kw));
}

// Extended media name resolution from URL domain
export function resolveMediaName(url: string, fallbackName?: string): string {
  try {
    const domain = new URL(url).hostname.replace(/^www\./, "");
    const map: Record<string, string> = {
      // Wire services
      "yna.co.kr": "연합뉴스",
      "yonhapnews.co.kr": "연합뉴스",
      "news1.kr": "뉴스1",
      "newsis.com": "뉴시스",
      // National dailies
      "chosun.com": "조선일보",
      "joongang.co.kr": "중앙일보",
      "joins.com": "중앙일보",
      "donga.com": "동아일보",
      "hani.co.kr": "한겨레",
      "khan.co.kr": "경향신문",
      "kmib.co.kr": "국민일보",
      "segye.com": "세계일보",
      "seoul.co.kr": "서울신문",
      "munhwa.com": "문화일보",
      "hankookilbo.com": "한국일보",
      // Economy
      "hankyung.com": "한국경제",
      "mk.co.kr": "매일경제",
      "mt.co.kr": "머니투데이",
      "fnnews.com": "파이낸셜뉴스",
      "heraldcorp.com": "헤럴드경제",
      "biz.heraldcorp.com": "헤럴드경제",
      "sedaily.com": "서울경제",
      "asiae.co.kr": "아시아경제",
      "edaily.co.kr": "이데일리",
      "inews24.com": "아이뉴스24",
      "etnews.com": "전자신문",
      "dt.co.kr": "디지털타임스",
      "bloter.net": "블로터",
      "zdnet.co.kr": "ZDNet Korea",
      "ddaily.co.kr": "디지털데일리",
      "boannews.com": "보안뉴스",
      "etoday.co.kr": "이투데이",
      "moneys.co.kr": "머니S",
      "newspim.com": "뉴스핌",
      "newstomato.com": "뉴스토마토",
      "dailian.co.kr": "데일리안",
      "businesspost.co.kr": "비즈니스포스트",
      "businesswatch.co.kr": "비즈니스워치",
      "hansbiz.co.kr": "한스경제",
      "fetv.co.kr": "FETV",
      "meconomynews.com": "매경이코노미",
      "econovill.com": "이코노빌",
      "mediapen.com": "미디어펜",
      // Broadcast
      "ytn.co.kr": "YTN",
      "yonhapnewstv.co.kr": "연합뉴스TV",
      "mbc.co.kr": "MBC",
      "kbs.co.kr": "KBS",
      "sbs.co.kr": "SBS",
      "jtbc.co.kr": "JTBC",
      "jtbc.joins.com": "JTBC",
      "tvchosun.com": "TV조선",
      "mbn.co.kr": "MBN",
      "ichannela.com": "채널A",
      // Internet news
      "nocutnews.co.kr": "노컷뉴스",
      "ohmynews.com": "오마이뉴스",
      "pressian.com": "프레시안",
      "mediatoday.co.kr": "미디어오늘",
      "sisain.co.kr": "시사IN",
      "sisajournal.com": "시사저널",
      "sisaon.co.kr": "시사오늘",
      "ilyo.co.kr": "일요신문",
      "mindlenews.com": "민들레",
      "vop.co.kr": "민중의소리",
      "kukinews.com": "쿠키뉴스",
      "breaknews.com": "브레이크뉴스",
      "skyedaily.com": "스카이데일리",
      "nspna.com": "NSP통신",
      "newswire.co.kr": "뉴스와이어",
      // Sports/Entertainment
      "sportschosun.com": "스포츠조선",
      "sportsworldi.com": "스포츠서울",
      "newsen.com": "뉴스엔",
      "mydaily.co.kr": "마이데일리",
      "starnews.co.kr": "스타뉴스",
      "xportsnews.com": "엑스포츠뉴스",
      "tenasia.hankyung.com": "텐아시아",
      "osen.co.kr": "OSEN",
      "topstarnews.net": "톱스타뉴스",
      "isplus.com": "일간스포츠",
      "stoo.com": "스포츠투데이",
      "tvdaily.co.kr": "TV데일리",
      "slist.kr": "스타일리스트",
      "bntnews.co.kr": "BNT뉴스",
      // Regional
      "kyeonggi.com": "경기신문",
      "kgib.co.kr": "경기일보",
      "joongboo.com": "중부일보",
      "joongboonews.com": "중부일보",
      "incheonilbo.com": "인천일보",
      "kihoilbo.co.kr": "기호일보",
      "gnnews.net": "경남신문",
      "knnews.co.kr": "경남도민일보",
      "ksilbo.co.kr": "경상일보",
      "ujeil.com": "울산신문",
      "kado.net": "강원도민일보",
      "kwnews.co.kr": "강원일보",
      "daejonilbo.com": "대전일보",
      "cctoday.co.kr": "충청투데이",
      "ccdn.co.kr": "충청일보",
      "cctimes.kr": "충청타임즈",
      "idaegu.co.kr": "대구신문",
      "idaegu.com": "대구일보",
      "kbmaeil.com": "경북매일신문",
      "kyongbuk.co.kr": "경북일보",
      "jeonbuk.com": "전북일보",
      "sjbnews.com": "새전북신문",
      "gwangju.com": "광주일보",
      "honam.co.kr": "전남일보",
      "namdonews.com": "남도일보",
      "jemin.com": "제민일보",
      "jejunews.com": "제주일보",
      "jejusori.net": "제주의소리",
      "ihalla.com": "한라일보",
      "imaeil.com": "매일신문",
      "yeongnam.com": "영남일보",
      "busan.com": "부산일보",
      "kookje.co.kr": "국제신문",
      // Religion
      "newscj.com": "기독신문",
      "christiantoday.co.kr": "크리스천투데이",
      "newsnjoy.or.kr": "뉴스앤조이",
      // Specialty
      "lawtimes.co.kr": "법률신문",
      "medipana.com": "메디파나뉴스",
      "monews.co.kr": "메디컬투데이",
      "dailymedi.com": "데일리메디",
      "doctorsnews.co.kr": "의학신문",
      "yakup.com": "약업신문",
      "nongmin.com": "농민신문",
      "agrinet.co.kr": "한국농어민신문",
      // Portals (fallback — we try to get real name)
      "news.naver.com": "네이버뉴스",
      "news.daum.net": "다음뉴스",
      "v.daum.net": "다음뉴스",
      "search.daum.net": "다음뉴스",
      // Entertainment sites
      "discoverynews.kr": "디스커버리뉴스",
    };
    const resolved = map[domain];
    if (resolved) return resolved;

    // For subdomains, try the parent domain
    const parts = domain.split(".");
    if (parts.length > 2) {
      const parent = parts.slice(-2).join(".");
      if (map[parent]) return map[parent];
    }

    if (
      fallbackName &&
      fallbackName !== "NEWS.GOOGLE" &&
      !fallbackName.toLowerCase().includes("google") &&
      !fallbackName.toLowerCase().includes("naver") &&
      !fallbackName.toLowerCase().includes("daum")
    ) {
      return fallbackName;
    }
    return domain;
  } catch {
    return fallbackName || "알수없음";
  }
}

// Deduplication check — URL-based + title+date fingerprint
// Also handles Google News vs original URL deduplication
export function isDuplicate(
  url: string,
  title: string,
  publishedAt: Date,
  existingSet: Set<string>,
): boolean {
  const normalizedUrl = url.toLowerCase().trim().replace(/\/$/, "");
  if (existingSet.has(normalizedUrl)) return true;

  const dateStr = publishedAt.toISOString().split("T")[0];
  const fingerprint = `${title.trim().replace(/\s+/g, "")}__${dateStr}`;
  if (existingSet.has(fingerprint)) return true;

  return false;
}

// Add URL and fingerprint to existing set
export function addToSet(url: string, title: string, publishedAt: Date, set: Set<string>): void {
  set.add(url.toLowerCase().trim().replace(/\/$/, ""));
  const dateStr = publishedAt.toISOString().split("T")[0];
  set.add(`${title.trim().replace(/\s+/g, "")}__${dateStr}`);
}

// Strip HTML tags
export function stripHtml(str: string): string {
  return str
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// Sleep utility
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Random delay 400-1200ms
export function randomDelay(): Promise<void> {
  return sleep(Math.random() * 800 + 400);
}

// Common HTTP headers
export const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  Connection: "keep-alive",
};

// Validate URL
export function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// Retry wrapper
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  delayMs = 1000,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < maxRetries) {
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

export interface ArticleData {
  title: string;
  content: string;
  url: string;
  publishedAt: Date;
  mediaName: string;
  isNegative: boolean;
  isSelfPR: boolean;
  source: string;
}
