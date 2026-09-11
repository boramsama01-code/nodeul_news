import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Configuration {
  naverApi: { configured: boolean };
  ai: { configured: boolean };
  crawlIntervalMinutes: number;
}
export default function SettingsPage() {
  const client = useQueryClient();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  async function saveKeys() {
    setSaving(true); setMessage("");
    try {
      const response = await fetch("/api/settings/naver-key", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({clientId,clientSecret})});
      if (!response.ok) throw new Error("키 저장에 실패했습니다.");
      setClientId(""); setClientSecret("");
      setMessage("저장했습니다. 데이터 수집 화면에서 수동 수집을 실행하면 바로 확인할 수 있습니다. 자동 수집에는 다음 실행부터 적용됩니다.");
      await client.invalidateQueries({queryKey:["settings"]});
    } catch(err) { setMessage(err instanceof Error ? err.message : "저장 실패"); }
    finally { setSaving(false); }
  }
  const { data, isError } = useQuery<Configuration>({
    queryKey: ["settings"],
    queryFn: async () => {
      const response = await fetch("/api/settings");
      if (!response.ok) throw new Error("설정을 불러오지 못했습니다.");
      return response.json();
    },
  });
  return <div className="space-y-6 max-w-2xl mx-auto">
    <h2 className="text-2xl font-bold">독립 실행 설정</h2>
    {isError && <p role="alert">서버 설정을 불러오지 못했습니다.</p>}
    <Card><CardHeader><CardTitle>네이버 API 키 등록</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">Replit에서 사용하던 네이버 Client ID와 Client Secret을 입력해 주세요. 키는 이 프로그램의 설정 파일에 저장됩니다.</p>
        <label className="block text-sm">Client ID<Input type="password" autoComplete="off" value={clientId} onChange={e=>setClientId(e.target.value)} /></label>
        <label className="block text-sm">Client Secret<Input type="password" autoComplete="off" value={clientSecret} onChange={e=>setClientSecret(e.target.value)} /></label>
        <Button disabled={saving || !clientId.trim() || !clientSecret.trim()} onClick={saveKeys}>{saving ? "저장 중" : "키 저장"}</Button>
        {message && <p role="status" className="text-sm">{message}</p>}
      </CardContent>
    </Card>
    <Card><CardHeader><CardTitle>수집 연결</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p>네이버 API: {data ? (data.naverApi.configured ? "키 설정됨 (실제 호출 결과는 수집 이력 확인)" : "키 미설정") : "확인 중"}</p>
        <p>다음 뉴스: 웹 검색 방식으로 수집하며 카카오 API 키는 필요하지 않습니다.</p>
        <p>구글뉴스·언론사 RSS: 별도 API 키가 필요하지 않습니다.</p>
        <p>감성 분석: {data?.ai.configured ? "AI 사용, 실패 시 규칙 기반 분석" : "무료 규칙 기반 분석"}</p>
        <p>자동 수집 간격: {data?.crawlIntervalMinutes ?? "—"}분. 수집 프로그램이 실행 중일 때 적용됩니다.</p>
      </CardContent>
    </Card>
    <Card><CardHeader><CardTitle>설정 변경 방법</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>네이버 키는 위에서 등록할 수 있습니다. 수집 간격은 설치 폴더의 .env 파일에서 CRAWL_INTERVAL_MINUTES 값을 바꾼 뒤 프로그램을 종료하고 다시 실행해 주세요.</p>
        <p>실제 실행 여부와 수집처 오류는 데이터 수집 화면의 ‘최근 수집 이력’에서 확인할 수 있습니다.</p>
      </CardContent>
    </Card>
  </div>;
}
