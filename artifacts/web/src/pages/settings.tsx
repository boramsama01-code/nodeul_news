import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Settings, Key, CheckCircle2, XCircle, Trash2, TestTube } from "lucide-react";

interface SettingsResponse {
  kakaoApiKey: {
    configured: boolean;
    masked: string | null;
  };
}

const API_BASE = "/api";

async function fetchSettings(): Promise<SettingsResponse> {
  const res = await fetch(`${API_BASE}/settings`);
  if (!res.ok) throw new Error("설정을 불러오지 못했습니다.");
  return res.json() as Promise<SettingsResponse>;
}

async function saveKakaoKey(key: string): Promise<{ ok: boolean; masked: string }> {
  const res = await fetch(`${API_BASE}/settings/kakao-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  const data = await res.json() as { ok?: boolean; masked?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? "저장 실패");
  return data as { ok: boolean; masked: string };
}

async function deleteKakaoKey(): Promise<void> {
  const res = await fetch(`${API_BASE}/settings/kakao-key`, { method: "DELETE" });
  if (!res.ok) throw new Error("삭제 실패");
}

async function testCrawl(): Promise<{ collected: number }> {
  const today = new Date().toISOString().split("T")[0]!;
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0]!;
  const startRes = await fetch(`${API_BASE}/crawl/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startDate: yesterday, endDate: today }),
  });
  if (!startRes.ok) throw new Error("수집 시작 실패");
  const { jobId } = await startRes.json() as { jobId: string };

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const statusRes = await fetch(`${API_BASE}/crawl/status/${jobId}`);
    const status = await statusRes.json() as { status: string; collected: number; error?: string };
    if (status.status === "done") return { collected: status.collected };
    if (status.status === "error") throw new Error(status.error ?? "수집 오류");
  }
  throw new Error("수집 시간 초과");
}

export default function SettingsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [inputKey, setInputKey] = useState("");
  const [isTesting, setIsTesting] = useState(false);

  const { data: settings, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: fetchSettings,
  });

  const saveMutation = useMutation({
    mutationFn: saveKakaoKey,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setInputKey("");
      toast({ title: "저장 완료", description: `카카오 REST API 키가 설정되었습니다. (${data.masked})` });
    },
    onError: (err: Error) => {
      toast({ title: "저장 실패", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteKakaoKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      toast({ title: "삭제 완료", description: "카카오 REST API 키가 제거되었습니다." });
    },
  });

  const handleTest = async () => {
    setIsTesting(true);
    try {
      const result = await testCrawl();
      toast({
        title: "수집 테스트 완료",
        description: `어제~오늘 기준 ${result.collected}건 수집되었습니다.`,
      });
    } catch (err) {
      toast({
        title: "수집 테스트 실패",
        description: err instanceof Error ? err.message : "알 수 없는 오류",
        variant: "destructive",
      });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Settings className="w-6 h-6 text-muted-foreground" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">설정</h1>
          <p className="text-sm text-muted-foreground mt-0.5">API 키 및 수집 설정을 관리합니다.</p>
        </div>
      </div>

      {/* Kakao API Key */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Key className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-base">다음(카카오) 뉴스 API</CardTitle>
            </div>
            {!isLoading && (
              settings?.kakaoApiKey.configured ? (
                <Badge variant="outline" className="text-green-600 border-green-300 bg-green-50 gap-1">
                  <CheckCircle2 className="w-3 h-3" /> 연결됨
                </Badge>
              ) : (
                <Badge variant="outline" className="text-orange-500 border-orange-300 bg-orange-50 gap-1">
                  <XCircle className="w-3 h-3" /> 미설정
                </Badge>
              )
            )}
          </div>
          <CardDescription>
            카카오 개발자 콘솔(<a href="https://developers.kakao.com" target="_blank" rel="noopener noreferrer" className="underline">developers.kakao.com</a>)에서 발급한 REST API 키를 입력하세요.
            설정하면 다음뉴스 검색 결과가 수집에 추가됩니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {settings?.kakaoApiKey.configured && (
            <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-4 py-3">
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">현재 키</p>
                <code className="text-sm font-mono">{settings.kakaoApiKey.masked}</code>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive gap-1.5"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
              >
                <Trash2 className="w-3.5 h-3.5" />
                삭제
              </Button>
            </div>
          )}

          <div className="flex gap-2">
            <Input
              type="password"
              placeholder="REST API 키 입력 (예: abc123def456...)"
              value={inputKey}
              onChange={(e) => setInputKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && inputKey.trim()) saveMutation.mutate(inputKey); }}
              className="font-mono text-sm"
            />
            <Button
              onClick={() => saveMutation.mutate(inputKey)}
              disabled={!inputKey.trim() || saveMutation.isPending}
            >
              {saveMutation.isPending ? "확인 중…" : "저장"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            저장 시 카카오 API로 유효성을 자동 검증합니다. 키는 서버에 안전하게 저장되며 외부로 노출되지 않습니다.
          </p>
        </CardContent>
      </Card>

      {/* Test Crawl */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <TestTube className="w-4 h-4 text-muted-foreground" />
            <CardTitle className="text-base">수집 테스트</CardTitle>
          </div>
          <CardDescription>어제~오늘 기간으로 빠른 수집 테스트를 실행합니다.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={handleTest} disabled={isTesting} variant="outline" className="gap-2">
            <TestTube className="w-4 h-4" />
            {isTesting ? "수집 중…" : "테스트 수집 실행"}
          </Button>
          {isTesting && (
            <p className="text-sm text-muted-foreground mt-3 animate-pulse">
              네이버 · 다음 · RSS 소스에서 수집 중입니다. 잠시 기다려 주세요…
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
