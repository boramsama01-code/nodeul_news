import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { readState, writeState, usesDatabaseState } from "./persistentState";
import { encryptConfig, decryptConfig } from "./configEncryption";

const configPath = () => join(process.env.DATA_DIR || ".local", "runtime-config.json");
interface RuntimeConfig {
  kakaoRestApiKey?: string;
  naverClientId?: string;
  naverClientSecret?: string;
}
async function readConfig(): Promise<RuntimeConfig> {
  if (usesDatabaseState()) {
    const encrypted = await readState<Parameters<typeof decryptConfig>[0]>("runtime-config");
    return encrypted ? decryptConfig<RuntimeConfig>(encrypted) : {};
  }
  try { return JSON.parse(await readFile(configPath(), "utf8")) as RuntimeConfig; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Saved configuration could not be loaded.");
  }
}
async function writeConfig(config: RuntimeConfig): Promise<void> {
  if (usesDatabaseState()) { await writeState("runtime-config", encryptConfig(config)); return; }
  await mkdir(dirname(configPath()), { recursive: true });
  const temporary = `${configPath()}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(config, null, 2), {mode: 0o600});
  await rename(temporary, configPath());
}
export async function setNaverKeys(clientId: string, clientSecret: string): Promise<void> {
  const config = await readConfig();
  config.naverClientId = clientId;
  config.naverClientSecret = clientSecret;
  await writeConfig(config);
  process.env.NAVER_CLIENT_ID = clientId;
  process.env.NAVER_CLIENT_SECRET = clientSecret;
}
export function getKakaoApiKey(): string | undefined { return process.env.KAKAO_REST_API_KEY; }
export function isKakaoApiKeySet(): boolean { return !!getKakaoApiKey(); }
export async function setKakaoApiKey(key: string): Promise<void> {
  const config = await readConfig();
  config.kakaoRestApiKey = key;
  await writeConfig(config);
  process.env.KAKAO_REST_API_KEY = key;
}
export async function deleteKakaoApiKey(): Promise<void> {
  const config = await readConfig();
  delete config.kakaoRestApiKey;
  await writeConfig(config);
  delete process.env.KAKAO_REST_API_KEY;
}
export async function loadRuntimeConfig(): Promise<void> {
  const config = await readConfig();
  if (config.naverClientId && config.naverClientSecret) {
    process.env.NAVER_CLIENT_ID = config.naverClientId;
    process.env.NAVER_CLIENT_SECRET = config.naverClientSecret;
  }
  if (config.kakaoRestApiKey) process.env.KAKAO_REST_API_KEY = config.kakaoRestApiKey;
}
