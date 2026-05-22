import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "../../../../.local/runtime-config.json");

interface RuntimeConfig {
  kakaoRestApiKey?: string;
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
  if (config.kakaoRestApiKey && !process.env.KAKAO_REST_API_KEY) {
    process.env.KAKAO_REST_API_KEY = config.kakaoRestApiKey;
  }
}
