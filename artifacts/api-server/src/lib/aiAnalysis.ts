import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";

let _client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    logger.warn("ANTHROPIC_API_KEY not set — AI analysis unavailable");
    return null;
  }
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });
  }
  return _client;
}

export async function analyzeArticleSentiment(
  title: string,
  content: string,
): Promise<boolean> {
  const client = getClient();
  if (!client) throw new Error("ANTHROPIC_API_KEY is not configured");

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 100,
    messages: [
      {
        role: "user",
        content: `다음 기사를 분석하여 노들섬에 대해 부정적인 내용인지 판단하세요.
부정적인 기사란: 노들섬 개발/운영/정책에 대한 비판, 문제점 지적, 반대 의견, 부정적 사건 보도 등을 포함합니다.
반드시 JSON만 반환하세요. 다른 텍스트 없이: {"isNegative": true} 또는 {"isNegative": false}

제목: ${title}
내용: ${content.slice(0, 500)}`,
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const cleaned = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(cleaned) as { isNegative: boolean };
  return parsed.isNegative;
}
