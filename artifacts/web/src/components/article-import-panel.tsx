import React, { useState } from "react";
import { FileSpreadsheet, Link2, Loader2, Upload } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

interface ImportItem {
  input: string;
  status: "inserted" | "duplicate" | "irrelevant" | "failed";
  title?: string;
  reason?: string;
}

interface ImportResponse {
  total: number;
  inserted: number;
  duplicates: number;
  irrelevant: number;
  failed: number;
  results: ImportItem[];
  resultsTruncated?: number;
  metadata?: { urlNote?: string; sheet?: string; rows?: number };
  error?: string;
}

function Summary({ result }: { result: ImportResponse }) {
  const problems = result.results.filter((item) => item.status === "failed" || item.status === "irrelevant").slice(0, 10);
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-2">
      <p className="font-medium">처리 {result.total}건 · 신규 {result.inserted} · 중복 {result.duplicates} · 관련성 제외 {result.irrelevant} · 실패 {result.failed}</p>
      {result.metadata?.urlNote && <p className="text-xs text-muted-foreground">{result.metadata.urlNote}</p>}
      {problems.length > 0 && <details>
        <summary className="cursor-pointer text-xs font-medium">확인이 필요한 항목 {Math.min(problems.length, 10)}건 보기</summary>
        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
          {problems.map((item, index) => <p key={`${item.input}-${index}`} className="break-all">{item.title || item.input} — {item.reason || item.status}</p>)}
        </div>
      </details>}
      {!!result.resultsTruncated && <p className="text-xs text-muted-foreground">상세 목록은 {result.resultsTruncated}건 생략했습니다. 합계에는 모두 반영되어 있습니다.</p>}
    </div>
  );
}

export function ArticleImportPanel({ onImported }: { onImported: () => void }) {
  const { toast } = useToast();
  const [urls, setUrls] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [urlPending, setUrlPending] = useState(false);
  const [filePending, setFilePending] = useState(false);
  const [result, setResult] = useState<ImportResponse | null>(null);

  async function importUrls() {
    if (!urls.trim()) return;
    setUrlPending(true); setResult(null);
    try {
      const response = await fetch("/api/articles/import-urls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      const data = await response.json() as ImportResponse;
      if (!response.ok) throw new Error(data.error || "URL 가져오기에 실패했습니다.");
      setResult(data); setUrls(""); onImported();
      toast({ title: "URL 가져오기 완료", description: `신규 ${data.inserted}건 · 중복 ${data.duplicates}건` });
    } catch (error) {
      toast({ title: "URL 가져오기 실패", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    } finally { setUrlPending(false); }
  }

  async function importBigKinds() {
    if (!file) return;
    setFilePending(true); setResult(null);
    try {
      const response = await fetch("/api/articles/import-bigkinds", {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      const data = await response.json() as ImportResponse;
      if (!response.ok) throw new Error(data.error || "빅카인즈 파일을 가져오지 못했습니다.");
      setResult(data); setFile(null); onImported();
      const input = document.getElementById("bigkinds-file") as HTMLInputElement | null;
      if (input) input.value = "";
      toast({ title: "빅카인즈 가져오기 완료", description: `신규 ${data.inserted}건 · 중복 ${data.duplicates}건` });
    } catch (error) {
      toast({ title: "빅카인즈 가져오기 실패", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    } finally { setFilePending(false); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Upload className="w-4 h-4" /> 누락 기사 보완</CardTitle>
        <CardDescription>CAPTCHA를 서버로 넘기지 않고, 담당자가 확인한 기사 주소나 빅카인즈 엑셀을 정상 경로로 추가합니다.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label className="flex items-center gap-2"><Link2 className="w-4 h-4" /> 기사 URL 일괄 추가</Label>
          <Textarea rows={5} value={urls} onChange={(event) => setUrls(event.target.value)} placeholder={"기사 주소를 한 줄에 하나씩 붙여넣으세요.\nhttps://언론사.example/article/1\nhttps://n.news.naver.com/..."} />
          <p className="text-xs text-muted-foreground">한 번에 최대 100개. 앱이 원문 페이지에서 제목·게시일·언론사·관련성을 확인하며, 확인할 수 없는 항목은 저장하지 않고 사유를 표시합니다.</p>
          <Button onClick={importUrls} disabled={urlPending || !urls.trim()}>
            {urlPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Link2 className="w-4 h-4 mr-2" />}
            URL 가져오기
          </Button>
        </div>

        <div className="border-t pt-5 space-y-2">
          <Label htmlFor="bigkinds-file" className="flex items-center gap-2"><FileSpreadsheet className="w-4 h-4" /> 빅카인즈 Excel 가져오기</Label>
          <Input id="bigkinds-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => setFile(event.target.files?.[0] || null)} />
          <p className="text-xs text-muted-foreground">빅카인즈의 기사 데이터 Excel에서 일자·언론사·제목을 자동 인식합니다. URL 열이 없으면 뉴스 식별자를 내부 중복키로 사용합니다. 최대 20,000행·25MB.</p>
          <Button variant="outline" onClick={importBigKinds} disabled={filePending || !file}>
            {filePending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileSpreadsheet className="w-4 h-4 mr-2" />}
            선택한 Excel 가져오기
          </Button>
        </div>

        {result && <Summary result={result} />}
      </CardContent>
    </Card>
  );
}
