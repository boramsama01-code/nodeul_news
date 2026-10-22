import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Configuration {
  naverApi: { configured: boolean };
  ai: { configured: boolean };
  crawlIntervalMinutes: number;
  deployment?: { cloud: boolean; trial: boolean; databaseExpiresAt: string | null; schedulerEnabled: boolean };
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
    <h2 className="text-2xl font-bold">운영 설정</h2>
    {isError && <p role="alert">서버 설정을 불러오지 못했습니다.</p>}
    {data?.deployment?.trial && <Card className="border-amber-300 bg-amber-50"><CardHeader><CardTitle>무료 시험 운영 중</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm text-amber-950">
        <p>15분 동안 접속이 없으면 서버와 자동 수집이 멈출 수 있습니다. 다시 접속하면 서버가 깨어나며 첫 화면이 열리기까지 약 1분 걸릴 수 있습니다.</p>
        <p>저장된 수집 기록을 기준으로 재시작 후 누락 기간을 다시 검색합니다. RSS 보관기간과 검색 한도 때문에 모든 누락 기사가 복원되지는 않습니다.</p>
        <p>무료 데이터베이스 만료: {data.deployment.databaseExpiresAt ? new Date(data.deployment.databaseExpiresAt).toLocaleString("ko-KR", {timeZone:"Asia/Seoul"}) : "생성 후 30일"}. 만료 전에 기사 목록을 엑셀로 내보내고 운영 방식을 결정해 주세요.</p>
      </CardContent></Card>}
    <Card><CardHeader><CardTitle>네이버 API 키 등록</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">네이버 Client ID와 Client Secret을 입력해 주세요. {data?.deployment?.cloud ? "키는 암호화하여 저장하며 서버가 재시작되어도 유지됩니다." : "키는 이 프로그램의 설정 파일에 저장됩니다."}</p>
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
        <p>자동 수집 간격: {data?.crawlIntervalMinutes ?? "—"}분. 한 번의 수집을 마친 뒤 기다리는 시간입니다. {data?.deployment?.cloud ? (data.deployment.schedulerEnabled ? "서버 실행 중에 작동합니다." : "이 웹서비스의 자동 수집은 꺼져 있습니다.") : "수집 프로그램이 실행 중일 때 적용됩니다."}</p>
      </CardContent>
    </Card>
    <Card><CardHeader><CardTitle>설정 변경 방법</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>네이버 키는 위에서 등록할 수 있습니다. 수집 간격은 {data?.deployment?.cloud ? "Render 설정의 CRAWL_INTERVAL_MINUTES 값을 바꾼 뒤 재배포하면 적용됩니다." : "설치 폴더의 .env 파일에서 CRAWL_INTERVAL_MINUTES 값을 바꾼 뒤 프로그램을 다시 실행해 주세요."}</p>
        <p>실제 실행 여부와 수집처 오류는 데이터 수집 화면의 ‘최근 수집 이력’에서 확인할 수 있습니다.</p>
      </CardContent>
    </Card>
  </div>;
}
