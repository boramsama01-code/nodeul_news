import React, { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ADMIN_REQUIRED_EVENT,
  endAdminSession,
  requestAdminLogin,
  startAdminSession,
  useAdminSession,
} from "@/lib/admin";

// Rendered once in the layout. Opens when a write is refused (401) or when the
// administrator presses the login button.
export function AdminLoginDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [required, setRequired] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const onRequest = (event: Event) => {
      const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason;
      setRequired(reason !== "manual");
      setError("");
      setOpen(true);
    };
    window.addEventListener(ADMIN_REQUIRED_EVENT, onRequest);
    return () => window.removeEventListener(ADMIN_REQUIRED_EVENT, onRequest);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true); setError("");
    try {
      const failure = await startAdminSession(password);
      if (failure) { setError(failure); return; }
      setPassword(""); setOpen(false);
      await queryClient.invalidateQueries();
    } catch {
      setError("서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally { setPending(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setPassword(""); }}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>관리자 로그인</DialogTitle>
            <DialogDescription>
              {required
                ? "이 작업은 관리자만 할 수 있습니다. 로그인한 뒤 같은 작업을 다시 실행해 주세요."
                : "수집 실행, 기사 수정·삭제, 키 등록, 엑셀 내보내기에 필요합니다. 로그인은 이 브라우저에서 8시간 유지됩니다."}
            </DialogDescription>
          </DialogHeader>
          <label className="block text-sm space-y-1">
            <span>관리자 비밀번호</span>
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={pending || !password}>{pending ? "확인 중" : "로그인"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AdminStatusButton({ compact = false }: { compact?: boolean }) {
  const queryClient = useQueryClient();
  const { data } = useAdminSession();
  if (data?.admin) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground"
        aria-label="관리자 로그아웃"
        onClick={async () => { await endAdminSession(); await queryClient.invalidateQueries(); }}
      >
        <LogOut className="w-4 h-4" />{compact ? null : <span>관리자 로그아웃</span>}
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground"
      aria-label="관리자 로그인"
      onClick={() => requestAdminLogin("manual")}
    >
      <KeyRound className="w-4 h-4" />{compact ? null : <span>관리자 로그인</span>}
    </Button>
  );
}
