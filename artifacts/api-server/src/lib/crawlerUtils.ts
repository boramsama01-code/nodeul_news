import { VERIFIED_PUBLISHERS } from "./verifiedPublishers";
export { isRelevant } from "./newsRelevance";

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

// Curated publisher identities, independent of how an article was collected.
// Most-specific suffix wins: mobile sports/entertainment subdomains must not
// inherit their parent newspaper's brand. Portals are deliberately excluded.
export const MEDIA_DOMAIN_MAP: Readonly<Record<string, string>> = {
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
      "meconomynews.com": "시장경제",
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
      "sportsworldi.com": "스포츠월드",
      "sportsseoul.com": "스포츠서울",
      "sports.donga.com": "스포츠동아",
      "sports.khan.co.kr": "스포츠경향",
      "sports.hankooki.com": "스포츠한국",
      "biz.chosun.com": "조선비즈",
      "h21.hani.co.kr": "한겨레21",
      "koreajoongangdaily.joins.com": "코리아중앙데일리",
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
      "slist.kr": "싱글리스트",
      "bntnews.co.kr": "BNT뉴스",
      // Regional
      "kyeonggi.com": "경기일보",
      "kgnews.co.kr": "경기신문",
      "kgib.co.kr": "경기일보",
      "joongboo.com": "중부일보",
      "joongboonews.com": "중부일보",
      "incheonilbo.com": "인천일보",
      "kihoilbo.co.kr": "기호일보",
      "gnnews.co.kr": "경남일보",
      "knnews.co.kr": "경남신문",
      "idomin.com": "경남도민일보",
      "ksilbo.co.kr": "경상일보",
      "ujeil.com": "울산제일일보",
      "ulsanpress.net": "울산신문",
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
      "honam.co.kr": "무등일보",
      "mdilbo.com": "무등일보",
      "jnilbo.com": "전남일보",
      "kwangju.co.kr": "광주일보",
      "jjan.kr": "전북일보",
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
      "newscj.com": "천지일보",
      "christiantoday.co.kr": "크리스천투데이",
      "newsnjoy.or.kr": "뉴스앤조이",
      // Specialty
      "lawtimes.co.kr": "법률신문",
      "medipana.com": "메디파나뉴스",
      "monews.co.kr": "메디칼업저버",
      "dailymedi.com": "데일리메디",
      "doctorsnews.co.kr": "의협신문",
      "yakup.com": "약업신문",
      "nongmin.com": "농민신문",
      "agrinet.co.kr": "한국농어민신문",
      // Additional brands already present in the application's source registry.
      "ajunews.com": "아주경제",
      "asiatoday.co.kr": "아시아투데이",
      "bizwatch.co.kr": "비즈워치",
      "imbc.com": "MBC",
      "koreatimes.co.kr": "코리아타임스",
      "koreaherald.com": "코리아헤럴드",
      "kyeongin.com": "경인일보",
      "joongdo.co.kr": "중도일보",
      "naeil.com": "내일신문",
      "hidomin.com": "경북도민일보",
      "gwangnam.co.kr": "광남일보",
      "kjdaily.com": "광주매일신문",
      "ggilbo.com": "금강일보",
      "dynews.co.kr": "동양일보",
      "iusm.co.kr": "울산매일",
      "jeollailbo.com": "전라일보",
      "domin.co.kr": "전북도민일보",
      "jbnews.com": "중부매일",
      "inews365.com": "충북일보",
      "ccdailynews.com": "충청일보",
      "dnews.co.kr": "대한경제",
      "metroseoul.co.kr": "메트로경제",
      "viva100.com": "브릿지경제",
      "ekn.kr": "에너지경제",
      "ilgansports.com": "일간스포츠",
      "kids.hankooki.com": "소년한국일보",
      "weekly.hankooki.com": "주간한국",
      "kids.donga.com": "어린이동아",
      "kids.kwnews.co.kr": "어린이강원일보",
      "hkbs.co.kr": "환경일보",
      "journalist.or.kr": "기자협회보",
      "economist.co.kr": "이코노미스트",
      "ntoday.co.kr": "투데이신문",
      "ebn.co.kr": "EBN",
      "pdjournal.com": "PD저널",
      "newspenguin.com": "뉴스펭귄",
      "seoulwire.com": "서울와이어",
      "womaneconomy.co.kr": "여성경제신문",
      "economicdaily.com": "이코노믹데일리",
      "pennmike.com": "펜앤드마이크",
      "hellodd.com": "헬로디디",
      "obs.co.kr": "OBS",
      // Entertainment sites
      "discoverynews.kr": "디스커버리뉴스",
};

const MEDIA_DOMAIN_KEYS = Object.keys(MEDIA_DOMAIN_MAP).sort((a, b) => b.length - a.length);

export function isPortalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return ["naver.com", "daum.net", "google.com", "google.co.kr", "news.google.co.kr", "naver.me"].some(
      domain => host === domain || host.endsWith(`.${domain}`),
    );
  } catch { return false; }
}

export function cleanPublisherName(value?: string): string {
  const name = stripHtml(value || "").replace(/^(?:Daum|다음|NAVER|네이버)\s*\|\s*/i, "").replace(/\s+/g, " ").trim();
  if (!name || name.length > 80 || /[<>\r\n]|https?:\/\//i.test(name) || /^구글뉴스-|^(최신|관련순)$/.test(name)) return "";
  if (/^(?:기타|알\s*수\s*없음|unknown|news|뉴스|publisher|언론사|네이버(?:\s*뉴스)?|다음(?:\s*뉴스)?|구글(?:\s*뉴스)?|naver(?:\s*(?:news|뉴스))?|daum(?:\s*(?:news|뉴스))?|google(?:\s*(?:news|뉴스))?|news\.google)$/i.test(name)) return "";
  // A domain alone is not evidence of a publisher name.
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(name)) return "";
  return name;
}

export function resolveMediaNameStrict(url: string): string {
  try {
    if (isPortalUrl(url)) return "";
    const domain = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    if (VERIFIED_PUBLISHERS[domain]) return VERIFIED_PUBLISHERS[domain];
    if (VERIFIED_PUBLISHERS[`www.${domain}`]) return VERIFIED_PUBLISHERS[`www.${domain}`];
    const key = MEDIA_DOMAIN_KEYS.find(key => domain === key || domain.endsWith(`.${key}`));
    return key ? MEDIA_DOMAIN_MAP[key] : "";
  } catch { return ""; }
}

// Some feeds use a homepage URL instead of the publisher's display name.
// Accept only verified mappings; never turn an unknown host or portal into a name.
export function resolvePublisherHint(value?: string): string {
  const hint = stripHtml(value || "").trim();
  if (/^https?:\/\//i.test(hint)) return resolveMediaNameStrict(hint);
  if (/^[a-z\d.-]+\.[a-z]{2,}\/?$/i.test(hint)) return resolveMediaNameStrict(`https://${hint}`);
  return cleanPublisherName(hint);
}

// Preserve the legacy non-strict fallback API; callers requiring an actual
// publisher must use the strict variant or the metadata resolver.
export function resolveMediaName(url: string, fallbackName?: string): string {
  const mapped = resolveMediaNameStrict(url);
  if (mapped) return mapped;
  const fallback = cleanPublisherName(extractPressName(fallbackName || ""));
  if (fallback) return fallback;
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return "알수없음"; }
}

// mediaName에서 순수 언론사명 추출
// "네이버(조선일보)" → "조선일보", "다음뉴스(뉴시스)" → "뉴시스"
// "구글뉴스(기타)" → "기타", "조선일보"(rss_direct) → "조선일보"
export function extractPressName(mediaName: string): string {
  const m = mediaName.match(/\((.+)\)$/);
  return m ? m[1] : mediaName;
}

// Collection source and the exact stored URL define identity; titles and publisher names do not.
function urlKey(url:string,source:string):string { return JSON.stringify([source,url]); }
export function isDuplicate(url:string,_title:string,_publishedAt:Date,existingSet:Set<string>,source="",_mediaName?:string):boolean {
 return existingSet.has(urlKey(url,source));
}
export function addToSet(url:string,_title:string,_publishedAt:Date,set:Set<string>,source="",_mediaName?:string):void {
 set.add(urlKey(url,source));
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

// Historical provenance comparison only. Never use this helper for collection deduplication or counting.
export function originalArticleKey(raw:string):string {
 try{const u=new URL(raw);const host=u.hostname.toLowerCase().replace(/^www\./,'');
 if(host==='mk.co.kr'){const id=u.pathname.match(/\/news\/[^/]+\/(\d+)\/?$/)?.[1];if(id)return 'mk:'+id;}
 if(host==='seoul.co.kr'||host==='m.seoul.co.kr'){const id=u.pathname.match(/\/(\d{14})\/?$/)?.[1]||u.searchParams.get('id');if(id&&/^\d{14}$/.test(id))return 'seoul:'+id;}
 u.hash='';for(const key of [...u.searchParams.keys()])if(/^utm_/i.test(key)||['ref','referrer','from','input','OutUrl'].includes(key))u.searchParams.delete(key);u.searchParams.sort();return host+u.pathname+'?'+u.searchParams.toString();
 }catch{return raw;}
}
