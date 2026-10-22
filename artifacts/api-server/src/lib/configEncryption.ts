import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

interface EncryptedConfig { version: 1; iv: string; tag: string; data: string }
function encryptionKey(): Buffer {
  const secret = process.env.CONFIG_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) throw new Error("CONFIG_ENCRYPTION_KEY must contain at least 32 characters.");
  return createHash("sha256").update(secret).digest();
}
export function encryptConfig(value: unknown): EncryptedConfig {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from("nodeul-news:runtime-config:v1"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") };
}
export function decryptConfig<T>(value: EncryptedConfig): T {
  if (value.version !== 1) throw new Error("Unsupported configuration version.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(value.iv, "base64"));
  decipher.setAAD(Buffer.from("nodeul-news:runtime-config:v1"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]).toString("utf8")) as T;
}
