import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(process.env.DATA_DIR || ".local", "runtime-config.json");

interface RuntimeConfig {
  kakaoRestApiKey?: string;
  naverClientId?: string;
  naverClientSecret?: string;
}

export function setNaverKeys(clientId: string, clientSecret: string): void {
  const config = readConfig();
  config.naverClientId = clientId;
  config.naverClientSecret = clientSecret;
  writeConfig(config);
  process.env.NAVER_CLIENT_ID = clientId;
  process.env.NAVER_CLIENT_SECRET = clientSecret;
}

function readConfig(): RuntimeConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as RuntimeConfig;
    }
  } catch {
  }
  return {};
}

function writeConfig(config: RuntimeConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

export function getKakaoApiKey(): string | undefined {
  return process.env.KAKAO_REST_API_KEY ?? readConfig().kakaoRestApiKey;
}

export function setKakaoApiKey(key: string): void {
  process.env.KAKAO_REST_API_KEY = key;
  const config = readConfig();
  config.kakaoRestApiKey = key;
  writeConfig(config);
}

export function deleteKakaoApiKey(): void {
  delete process.env.KAKAO_REST_API_KEY;
  const config = readConfig();
  delete config.kakaoRestApiKey;
  writeConfig(config);
}

export function isKakaoApiKeySet(): boolean {
  return !!getKakaoApiKey();
}

export function loadRuntimeConfig(): void {
  const config = readConfig();
  if (config.naverClientId && config.naverClientSecret) {
    process.env.NAVER_CLIENT_ID = config.naverClientId;
    process.env.NAVER_CLIENT_SECRET = config.naverClientSecret;
  }
  if (config.kakaoRestApiKey && !process.env.KAKAO_REST_API_KEY) {
    process.env.KAKAO_REST_API_KEY = config.kakaoRestApiKey;
  }
}
