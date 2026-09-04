import React, { useEffect, useState } from "react";
import {
  getListArticlesQueryKey,
  getListTrashArticlesQueryKey,
  useListTrashArticles,
  useRestoreArticle,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, ChevronRight, RotateCcw, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const PAGE_SIZE = 20;

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export default function Trash() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const queryParams = { page, limit: PAGE_SIZE };
  const { data, isLoading } = useListTrashArticles(queryParams, {
    query: { queryKey: getListTrashArticlesQueryKey(queryParams) },
  });
  const restoreArticle = useRestoreArticle();

  useEffect(() => {
    setPage(1);
  }, []);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListTrashArticlesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListArticlesQueryKey() });
    queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
  };

  const handleRestore = (id: number) => {
    if (!confirm("이 기사를 복원하시겠습니까?")) return;
    restoreArticle.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "기사 복원 완료", description: "기사 목록과 통계에 다시 반영됩니다." });
          invalidate();
        },
        onError: () => toast({ title: "복원 실패", variant: "destructive" }),
      },
    );
  };

  const totalPages = data?.totalPages ?? 1;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Trash2 className="w-6 h-6 text-muted-foreground" />
          휴지통
        </h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          휴지통의 기사는 대시보드·통계에서 제외되며, 재수집되지 않습니다.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            삭제된 기사 <span className="text-muted-foreground font-normal">({data?.total ?? 0}건)</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-5">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-y bg-muted/30 text-muted-foreground">
                    <th className="px-4 py-3 text-left font-medium">기사</th>
                    <th className="px-4 py-3 text-left font-medium whitespace-nowrap">언론사</th>
                    <th className="px-4 py-3 text-left font-medium whitespace-nowrap">기사 발행일</th>
                    <th className="px-4 py-3 text-left font-medium whitespace-nowrap">휴지통 이동일</th>
                    <th className="px-4 py-3 text-center font-medium">복원</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.data.map((article) => (
                    <tr key={article.id} className="border-b last:border-0 hover:bg-muted/20">
                      <td className="px-4 py-3 min-w-[280px]">
                        <div className="font-medium line-clamp-1">{article.title}</div>
                        <a
                          href={article.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-muted-foreground hover:text-primary line-clamp-1 mt-0.5"
                        >
                          {article.url}
                        </a>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">{article.mediaName}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{formatDate(article.publishedAt)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                        {article.deletedAt ? formatDate(article.deletedAt) : "-"}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleRestore(article.id)}
                          disabled={restoreArticle.isPending}
                        >
                          <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                          복원
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {(!data?.data || data.data.length === 0) && (
                    <tr>
                      <td colSpan={5} className="px-4 py-14 text-center text-muted-foreground">
                        휴지통이 비어 있습니다.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t flex items-center justify-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page === 1}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="text-sm text-muted-foreground">{page} / {totalPages}</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={page === totalPages}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}